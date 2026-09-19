// coversld.js — the style an operator publishes a cover source with.
//
// FND.12. A cover source reaches the world as a class raster: one flat colour
// per class, and nothing where the source says nothing. A raster source such
// as ESA WorldCover already is one; a vector source — swissTLM3D, OSM — is one
// the operator paints, and this writes the paint.
//
// The colour of a class is computed, not chosen: injective in the code, so the
// compiler reading the picture back gets the class that was written, and far
// enough apart in hue that a person looking at the map can tell forest from
// rock. The same three lines are in tools/geoserver_cover.py, which publishes
// the fixtures the stories map.

export const colourOf = (code) => {
    const n = Number(code) & 0xFF;
    return `#${[n, (n * 73 + 41) & 0xFF, (n * 151 + 97) & 0xFF]
        .map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

const escaped = (text) => String(text ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * An SLD that paints each of a source's values in its own class colour.
 *
 * @param {string} name what the style is called
 * @param {string} field the attribute the classes are in
 * @param {{value: string, colour: string}[]} rows
 */
export function sldFor(name, field, rows) {
    const rules = (rows ?? []).filter((r) => r.value && r.colour).map((r) => `
    <Rule>
      <Name>${escaped(r.value)}</Name>
      <ogc:Filter>
        <ogc:PropertyIsEqualTo>
          <ogc:PropertyName>${escaped(field)}</ogc:PropertyName>
          <ogc:Literal>${escaped(r.value)}</ogc:Literal>
        </ogc:PropertyIsEqualTo>
      </ogc:Filter>
      <PolygonSymbolizer>
        <Fill><CssParameter name="fill">${escaped(r.colour)}</CssParameter></Fill>
      </PolygonSymbolizer>
    </Rule>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
    xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">
  <NamedLayer>
    <Name>${escaped(name)}</Name>
    <UserStyle>
      <Title>${escaped(name)} — splatworld ground cover</Title>
      <FeatureTypeStyle>${rules}
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
`;
}
