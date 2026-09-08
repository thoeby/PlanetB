-- WP2.1 — osm2pgsql flex style. Everything splatworld can build from OSM, and
-- nothing else: roads, forest, water and building footprints, into one staging
-- table that tools/seed-osm.sh maps onto `feature` rows.
--
-- Staging rather than straight into `feature` because a feature needs an
-- `area_id`, and the areas are the seed's own (one per z12 tile). osm2pgsql
-- knows nothing about them.

local seed = osm2pgsql.define_table({
    name = 'osm_seed',
    schema = 'seed',
    ids = { type = 'any', id_column = 'osm_id', type_column = 'osm_type' },
    columns = {
        { column = 'kind', type = 'text', not_null = true },
        { column = 'props', type = 'jsonb' },
        { column = 'geom', type = 'geometry', projection = 4326, not_null = true },
    }
})

-- Everything a vehicle or a person moves along. The value is the road profile
-- assemble-v1 cuts into the terrain (ARCHITECTURE §6), in metres.
local ROAD_WIDTH = {
    motorway = 22, motorway_link = 8, trunk = 14, trunk_link = 7,
    primary = 11, primary_link = 6, secondary = 9, secondary_link = 6,
    tertiary = 7, tertiary_link = 5, unclassified = 5, residential = 5,
    living_street = 5, pedestrian = 4, service = 3.5, track = 3,
    footway = 1.5, path = 1.2, cycleway = 2, steps = 1.5,
}

-- "12", "12 m", "12.5m" -> 12.5; anything else -> nil.
local function metres(v)
    if not v then return nil end
    return tonumber(v:match('^%s*([%d.]+)'))
end

local function classify(tags)
    if tags.building and tags.building ~= 'no' then
        return 'footprint', {
            height = metres(tags.height),
            levels = tonumber(tags['building:levels']),
            roof = tags['roof:shape'],
            use = tags.building,
        }
    end
    if tags.landuse == 'forest' or tags.natural == 'wood' then
        return 'forest', { leaf_type = tags.leaf_type, species = tags.species }
    end
    if tags.natural == 'water' or tags.landuse == 'reservoir'
        or tags.waterway == 'riverbank' or tags.water then
        return 'water', { water = tags.water or tags.natural }
    end
    local w = ROAD_WIDTH[tags.highway]
    if w then
        return 'road', {
            class = tags.highway,
            width = metres(tags.width) or w,
            lanes = tonumber(tags.lanes),
            bridge = tags.bridge and tags.bridge ~= 'no' or nil,
            tunnel = tags.tunnel and tags.tunnel ~= 'no' or nil,
        }
    end
    return nil, nil
end

function osm2pgsql.process_way(object)
    local kind, props = classify(object.tags)
    if not kind then return end
    if kind == 'road' then
        if object.is_closed and object.tags.area == 'yes' then return end
        seed:insert({ kind = kind, props = props, geom = object:as_linestring() })
    elseif object.is_closed then
        seed:insert({ kind = kind, props = props, geom = object:as_polygon() })
    end
end

function osm2pgsql.process_relation(object)
    if object.tags.type ~= 'multipolygon' then return end
    local kind, props = classify(object.tags)
    if not kind or kind == 'road' then return end
    seed:insert({ kind = kind, props = props, geom = object:as_multipolygon() })
end
