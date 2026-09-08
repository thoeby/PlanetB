<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
    xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">
  <NamedLayer>
    <Name>area</Name>
    <UserStyle>
      <Title>Areas by detail</Title>
      <FeatureTypeStyle>
        <Rule>
          <PolygonSymbolizer>
            <Fill><CssParameter name="fill">#2980b9</CssParameter>
                  <CssParameter name="fill-opacity">0.08</CssParameter></Fill>
            <Stroke><CssParameter name="stroke">#2980b9</CssParameter>
                    <CssParameter name="stroke-width">2</CssParameter></Stroke>
          </PolygonSymbolizer>
          <TextSymbolizer>
            <Label><ogc:PropertyName>detail</ogc:PropertyName></Label>
            <Fill><CssParameter name="fill">#2980b9</CssParameter></Fill>
          </TextSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
