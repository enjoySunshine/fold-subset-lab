import * as r from 'restructure';

// Flags for simple glyphs
const ON_CURVE = 1 << 0;
const X_SHORT_VECTOR = 1 << 1;
const Y_SHORT_VECTOR = 1 << 2;
const REPEAT = 1 << 3;
const SAME_X = 1 << 4;
const SAME_Y = 1 << 5;

class Point {
  static size(val) {
    return val >= 0 && val <= 255 ? 1 : 2;
  }

  static encode(stream, value) {
    if (value >= 0 && value <= 255) {
      stream.writeUInt8(value);
    } else {
      stream.writeInt16BE(value);
    }
  }
}

let Glyf = new r.Struct({
  numberOfContours: r.int16, // if negative, this is a composite glyph
  xMin: r.int16,
  yMin: r.int16,
  xMax: r.int16,
  yMax: r.int16,
  endPtsOfContours: new r.Array(r.uint16, 'numberOfContours'),
  instructions: new r.Array(r.uint8, r.uint16),
  flags: new r.Array(r.uint8, 0),
  xPoints: new r.Array(Point, 0),
  yPoints: new r.Array(Point, 0),
});

// Flags for composite glyphs
const ARG_1_AND_2_ARE_WORDS = 1 << 0;
const ARGS_ARE_XY_VALUES = 1 << 1;
const WE_HAVE_A_SCALE = 1 << 3;
const MORE_COMPONENTS = 1 << 5;
const WE_HAVE_AN_X_AND_Y_SCALE = 1 << 6;
const WE_HAVE_A_TWO_BY_TWO = 1 << 7;

// Converts a scale factor to the OpenType F2Dot14 fixed-point format. The
// field is a signed int16, so a raw fixed value of 0x8000 or above (a scale
// of about 2 or more) is wrapped to its signed representation so setInt16
// accepts it and the decoder reads back the same bit pattern.
function toFixed2Dot14(value) {
  let fixed = Math.round(value * 16384) & 0xffff;
  return fixed >= 0x8000 ? fixed - 0x10000 : fixed;
}

/**
 * Encodes TrueType glyph outlines
 */
export default class TTFGlyphEncoder {
  // Encodes a composite glyph from its decoded components, remapping each
  // component's glyph id to its id in the subset. The component offsets and
  // scales are kept as they are, so a composite stays a composite.
  encodeComposite(bbox, components) {
    // Each component record is at most: flags(2) + glyphID(2) + args(4) +
    // 2x2 transform(8) = 16 bytes. Size the buffer for the worst case and
    // write through a plain DataView, so every offset is computed explicitly.
    let maxSize = 10 + components.length * 16;
    let bytes = new Uint8Array(maxSize);
    let view = new DataView(bytes.buffer);
    let pos = 0;

    view.setInt16(pos, -1);
    view.setInt16(pos + 2, bbox.minX);
    view.setInt16(pos + 4, bbox.minY);
    view.setInt16(pos + 6, bbox.maxX);
    view.setInt16(pos + 8, bbox.maxY);
    pos = 10;

    for (let i = 0; i < components.length; i++) {
      let component = components[i];
      let dx = Math.round(component.dx);
      let dy = Math.round(component.dy);
      let wordArgs = dx < -128 || dx > 127 || dy < -128 || dy > 127;

      let isUniformScale =
        component.scaleX === component.scaleY &&
        component.scale01 === 0 &&
        component.scale10 === 0 &&
        component.scaleX !== 1;
      let isTwoByTwo = component.scale01 !== 0 || component.scale10 !== 0;
      let isXYScale =
        !isUniformScale &&
        !isTwoByTwo &&
        (component.scaleX !== 1 || component.scaleY !== 1);

      let flags = ARGS_ARE_XY_VALUES;
      if (wordArgs) {
        flags |= ARG_1_AND_2_ARE_WORDS;
      }
      if (isUniformScale) {
        flags |= WE_HAVE_A_SCALE;
      } else if (isTwoByTwo) {
        flags |= WE_HAVE_A_TWO_BY_TWO;
      } else if (isXYScale) {
        flags |= WE_HAVE_AN_X_AND_Y_SCALE;
      }
      if (i < components.length - 1) {
        flags |= MORE_COMPONENTS;
      }

      view.setUint16(pos, flags);
      view.setUint16(pos + 2, component.glyphID);
      pos += 4;
      if (wordArgs) {
        view.setInt16(pos, dx);
        view.setInt16(pos + 2, dy);
        pos += 4;
      } else {
        view.setInt8(pos, dx);
        view.setInt8(pos + 1, dy);
        pos += 2;
      }

      if (isUniformScale) {
        view.setInt16(pos, toFixed2Dot14(component.scaleX));
        pos += 2;
      } else if (isXYScale) {
        // The XY-scale record holds two int16 values only: scaleX, scaleY.
        view.setInt16(pos, toFixed2Dot14(component.scaleX));
        view.setInt16(pos + 2, toFixed2Dot14(component.scaleY));
        pos += 4;
      } else if (isTwoByTwo) {
        // The 2x2 record holds four int16 values: scaleX, scale01, scale10, scaleY.
        view.setInt16(pos, toFixed2Dot14(component.scaleX));
        view.setInt16(pos + 2, toFixed2Dot14(component.scale01));
        view.setInt16(pos + 4, toFixed2Dot14(component.scale10));
        view.setInt16(pos + 6, toFixed2Dot14(component.scaleY));
        pos += 8;
      }
    }

    // Pad to a multiple of four bytes, as in encodeSimple.
    let tail = (4 - (pos % 4)) % 4;
    return bytes.subarray(0, pos + tail);
  }

  encodeSimple(path, instructions = []) {
    let endPtsOfContours = [];
    let xPoints = [];
    let yPoints = [];
    let flags = [];
    let same = 0;
    let lastX = 0,
      lastY = 0,
      lastFlag = 0;
    let pointCount = 0;

    for (let i = 0; i < path.commands.length; i++) {
      let c = path.commands[i];

      for (let j = 0; j < c.args.length; j += 2) {
        let x = c.args[j];
        let y = c.args[j + 1];
        let flag = 0;

        // If the ending point of a quadratic curve is the midpoint
        // between the control point and the control point of the next
        // quadratic curve, we can omit the ending point.
        if (c.command === 'quadraticCurveTo' && j === 2) {
          let next = path.commands[i + 1];
          if (next && next.command === 'quadraticCurveTo') {
            let midX = (lastX + next.args[0]) / 2;
            let midY = (lastY + next.args[1]) / 2;

            if (x === midX && y === midY) {
              continue;
            }
          }
        }

        // All points except control points are on curve.
        if (!(c.command === 'quadraticCurveTo' && j === 0)) {
          flag |= ON_CURVE;
        }

        flag = this._encodePoint(
          x,
          lastX,
          xPoints,
          flag,
          X_SHORT_VECTOR,
          SAME_X,
        );
        flag = this._encodePoint(
          y,
          lastY,
          yPoints,
          flag,
          Y_SHORT_VECTOR,
          SAME_Y,
        );

        if (flag === lastFlag && same < 255) {
          flags[flags.length - 1] |= REPEAT;
          same++;
        } else {
          if (same > 0) {
            flags.push(same);
            same = 0;
          }

          flags.push(flag);
          lastFlag = flag;
        }

        lastX = x;
        lastY = y;
        pointCount++;
      }

      if (c.command === 'closePath') {
        endPtsOfContours.push(pointCount - 1);
      }
    }

    if (same > 0) {
      flags.push(same);
    }

    // Close the path if the last command didn't already
    if (
      path.commands.length > 1 &&
      path.commands[path.commands.length - 1].command !== 'closePath'
    ) {
      endPtsOfContours.push(pointCount - 1);
    }

    let bbox = path.cbox;
    let glyf = {
      numberOfContours: endPtsOfContours.length,
      xMin: bbox.minX,
      yMin: bbox.minY,
      xMax: bbox.maxX,
      yMax: bbox.maxY,
      endPtsOfContours: endPtsOfContours,
      instructions: instructions,
      flags: flags,
      xPoints: xPoints,
      yPoints: yPoints,
    };

    let size = Glyf.size(glyf);
    let tail = 4 - (size % 4);

    let stream = new r.EncodeStream(new Uint8Array(size + tail));
    Glyf.encode(stream, glyf);

    // Align to 4-byte length
    if (tail !== 0) {
      stream.fill(0, tail);
    }

    return stream.buffer;
  }

  _encodePoint(value, last, points, flag, shortFlag, sameFlag) {
    let diff = value - last;

    if (value === last) {
      flag |= sameFlag;
    } else {
      if (-255 <= diff && diff <= 255) {
        flag |= shortFlag;
        if (diff < 0) {
          diff = -diff;
        } else {
          flag |= sameFlag;
        }
      }

      points.push(diff);
    }

    return flag;
  }
}
