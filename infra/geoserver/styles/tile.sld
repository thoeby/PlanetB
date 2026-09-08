<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
    xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">
  <NamedLayer>
    <Name>tile</Name>
    <UserStyle>
      <Title>Compile state</Title>
      <FeatureTypeStyle>
        <Rule>
          <Title>never published</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo>
            <ogc:PropertyName>status</ogc:PropertyName><ogc:Literal>unpublished</ogc:Literal>
          </ogc:PropertyIsEqualTo></ogc:Filter>
          <PolygonSymbolizer>
            <Fill><CssParameter name="fill">#c0392b</CssParameter>
                  <CssParameter name="fill-opacity">0.25</CssParameter></Fill>
            <Stroke><CssParameter name="stroke">#c0392b</CssParameter></Stroke>
          </PolygonSymbolizer>
        </Rule>
        <Rule>
          <Title>published but stale</Title>
          <ogc:Filter><ogc:PropertyIsEqualTo>
            <ogc:PropertyName>status</ogc:PropertyName><ogc:Literal>stale</ogc:Literal>
          </ogc:PropertyIsEqualTo></ogc:Filter>
          <PolygonSymbolizer>
            <Fill><CssParameter name="fill">#e67e22</CssParameter>
                  <CssParameter name="fill-opacity">0.25</CssParameter></Fill>
            <Stroke><CssParameter name="stroke">#e67e22</CssParameter></Stroke>
          </PolygonSymbolizer>
        </Rule>
        <Rule>
          <Title>current</Title>
          <PolygonSymbolizer>
            <Fill><CssParameter name="fill">#27ae60</CssParameter>
                  <CssParameter name="fill-opacity">0.15</CssParameter></Fill>
            <Stroke><CssParameter name="stroke">#27ae60</CssParameter></Stroke>
          </PolygonSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
