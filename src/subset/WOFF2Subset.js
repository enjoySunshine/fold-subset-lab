import TTFSubset from './TTFSubset';

/**
 * Subsets a WOFF2 font whose glyf table is stored in the WOFF2 transformed
 * format. The transformed glyf and loca tables cannot be sliced the way a
 * plain sfnt font's can, so every included glyph is re-encoded from its
 * decoded outline: simple glyphs from their path, and composite glyphs from
 * their components. Composite glyphs stay composite, with their component
 * offsets intact and their component ids remapped to their ids in the subset.
 */
export default class WOFF2Subset extends TTFSubset {
  _addGlyph(gid) {
    let glyph = this.font.getGlyph(gid);
    let glyf = glyph._decode();

    let buffer;
    if (glyf && glyf.numberOfContours < 0) {
      // Composite glyph: include every component first, then write the
      // composite with the subset's component ids. The components' offsets
      // and scales are preserved, so the glyph is not flattened.
      let components = glyf.components.map((component) => {
        let componentGid = this.includeGlyph(component.glyphID);
        return { ...component, glyphID: componentGid };
      });
      buffer = this.glyphEncoder.encodeComposite(glyph.path.cbox, components);
    } else if (glyf && glyf.numberOfContours > 0) {
      // The WOFF2 transform does not keep instruction bytes available here,
      // so simple glyphs are re-encoded from their decoded path.
      buffer = this.glyphEncoder.encodeSimple(glyph.path, []);
    } else {
      // Glyphs without an outline (e.g. the missing glyph) take no space.
      buffer = new Uint8Array(0);
    }

    let bearing = glyph._getMetrics().leftBearing;
    if (glyf && this.font._variationProcessor) {
      // A varied glyph's side bearing is measured from its varied outline,
      // the same way TTFSubset measures re-encoded variation glyphs.
      bearing = glyph.path.cbox.minX;
    }

    this.glyf.push(buffer);
    this.loca.offsets.push(this.offset);

    this.hmtx.metrics.push({
      advance: glyph.advanceWidth,
      bearing,
    });

    this.offset += buffer.length;
    return this.glyf.length - 1;
  }
}
