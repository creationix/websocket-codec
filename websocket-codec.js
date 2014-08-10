"use strict";

var bodec = require('bodec');

// This module is a stream transform that converts between raw binary stream
// chunks and websocket message objects with { fin, opcode, mask, body }
// This module is sync and can thus be easily integrated into async streams
// that require backpressure.

// Decode from raw stream to objects
exports.decoder = decoder;
// Encode object stream to framed stream
exports.encoder = encoder;

function decoder(emit) {
  // 0-flags, 1-len, 2-lenx, 3-mask, 4-raw-data, 5-masked-data
  var state;
  var offset;
  var fin, opcode, mask, length;
  var key = new Uint8Array(4);
  var body;
  reset();
  return decode;

  function reset() {
    state = 0;
    offset = 0;
    fin = 0;
    opcode = 0;
    mask = 0;
    length = 0;
    key[0] = 0;
    key[1] = 0;
    key[2] = 0;
    key[3] = 0;
    body = null;
  }

  function decode(chunk) {
    // Pass through falsy values (including undefined for EOS)
    if (!chunk) return emit(chunk);

    if (!bodec.isBinary(chunk)) {
      throw new TypeError("chunk must be binary value");
    }

    // Parse the chunk using the state machine
    for (var i = 0, l = chunk.length; i < l; i++) {
      // Uncomment this to debug the state machine
      // console.log("S:" + state +
      //           " B:" + chunk[i].toString(16) +
      //           " O:" + offset +
      //           " F:" + fin +
      //           " OP:" + opcode +
      //           " M:" + mask +
      //           " L:" + length +
      //           " K:" + [].slice.call(key)
      // );

      var byte = chunk[i];
      if (state === 0) {
        fin = byte >> 7 & 1;
        opcode = byte & 0xf;
        state = 1;
      }
      else if (state === 1) {
        mask = byte >> 7 & 1;
        length = byte & 0x7f;
        if (length < 126) {
          state = mask ? 3 : 4;
          body = bodec.create(length);
          if (!length && !mask) flush();
        }
        else {
          offset = length === 127 ? 56 : 8;
          length = 0;
          state = 2;
        }
      }
      else if (state === 2) {
        length |= byte << offset;
        if (offset) {
          offset -= 8;
        }
        else {
          length = length >>> 0;
          state = mask ? 3 : 4;
          body = bodec.create(length);
          if (!length && !mask) flush();
        }
      }
      else if (state === 3) {
        key[offset++] = byte;
        if (offset === 4) {
          offset = 0;
          state = 5;
          body = bodec.create(length);
          if (!length) flush();
        }
      }
      else if (state === 4) {
        // TODO: Implement fast copy for non-masked frames.
        // This is low priority since client encoding is always masked and this
        // code almost always runs in the server.
        body[offset] = byte;
        if (++offset >= length) flush();
      }
      else if (state === 5) {
        body[offset] = byte ^ key[offset % 4];
        if (++offset >= length) flush();
      }
    }
  }

  function flush() {
    var output = {
      fin: fin,
      opcode: opcode,
      mask: mask
    };
    if (opcode === 1) output.body = bodec.toUnicode(body);
    else output.body = body;
    reset();
    emit(output);
  }
}

function encoder(emit) {

  return function (object) {
    if (object === undefined) return emit();

    var isText = typeof object.body === "string";
    var body;
    if (isText) {
      body = bodec.fromUnicode(object.body);
    }
    else {
      body = object.body;
    }
    if (!bodec.isBinary(body)) {
      throw new TypeError("object.body must be string or binary");
    }
    var fin;
    if ("fin" in object) {
      fin = !!object.fin ? 1 : 0;
    }
    else {
      fin = 1;
    }

    var opcode;
    if ("opcode" in object) {
      if (typeof object.opcode !== "number") {
        throw new TypeError("object.opcode must be number");
      }
      opcode = object.opcode & 0xf;
    }
    else {
      opcode = isText ? 1 : 2;
    }

    var mask;
    if ("mask" in object) {
      mask = !!object.mask ? 1 : 0;
    }
    else {
      mask = 0;
    }

    var length = body.length;

    var keyOffset = length < 126 ? 2 :
      length < 0x10000 ? 4 : 10;

    var chunkLength = keyOffset;

    if (object.mask) {
      chunkLength += 4;
    }

    var chunk = bodec.create(chunkLength);

    chunk[0] = fin << 7 | opcode;
    chunk[1] = mask << 7 | (
      length < 126 ? length :
      length < 0x10000 ? 126 : 127);

    if (length >= 126) {
      if (length < 0x10000) {
        chunk[2] = length >> 8 & 0xff;
        chunk[3] = length >> 0 & 0xff;
      }
      else {
        var top = Math.floor(length / 0x100000000);
        chunk[2] = top >> 8 & 0xff;
        chunk[3] = top >> 16 & 0xff;
        chunk[4] = top >> 8 & 0xff;
        chunk[5] = top >> 0 & 0xff;
        chunk[6] = length >> 24 & 0xff;
        chunk[7] = length >> 16 & 0xff;
        chunk[8] = length >> 8 & 0xff;
        chunk[9] = length >> 0 & 0xff;
      }
    }

    if (mask) {
      // TODO: this is low priority because servers don't need to mask and this
      // library is usually used in servers.
      throw "TODO: Implement encoder masking";
    }

    emit(chunk);
    if (body.length) emit(body);
  };
}
