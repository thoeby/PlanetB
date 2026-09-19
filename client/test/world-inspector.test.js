// FND.14 — what the inspector writes when a World block is filled in, and the
// two inputs a flow keeps for it.
//
// The widgets themselves are the story's (client/test/run/29-world-blocks);
// what is here is what they write into the graph, which is what the ELX gets.

import test from 'node:test';
import assert from 'node:assert/strict';

import { addWorldInputs, constantOf, isWorldBlock, missingWorldInputs,
    setConstant, usesWorld, widgetFor, WORLD_INPUTS } from '../js/flowworld.js';

const block = (plugin = 'world') => ({ _irPlugin: plugin, _irKind: 'node',
    _irConstants: [], graph: null, inputs: [] });

test('a World block is known by its plugin, and a flow by having one', () => {
    assert.equal(isWorldBlock(block()), true);
    assert.equal(isWorldBlock(block('http')), false);
    assert.equal(usesWorld({ _nodes: [block('http')] }), false);
    assert.equal(usesWorld({ _nodes: [block('http'), block()] }), true);
    assert.equal(usesWorld(null), false);
});

test('a constant is written in the ELX shape, and read back out of it', () => {
    const node = block();
    setConstant(node, 'Object', 'abc-123');
    assert.deepEqual(node._irConstants, [{ port: 'Object',
        value: { structure: 'droplet', value: { id: 'string', data: 'abc-123' } } }]);
    assert.equal(constantOf(node, 'Object'), 'abc-123');
    assert.equal(constantOf(node, 'Port'), '');
});

test('typing nothing leaves the port deliberately empty, not unmentioned', () => {
    const node = block();
    setConstant(node, 'Value', 'true');
    setConstant(node, 'Value', '');
    assert.deepEqual(node._irConstants, [{ port: 'Value' }]);
    assert.equal(constantOf(node, 'Value'), '');
});

test('the value widget follows the kind of port the product declares', () => {
    assert.equal(widgetFor('boolean'), 'boolean');
    assert.equal(widgetFor('number'), 'number');
    assert.equal(widgetFor('colour'), 'colour');
    assert.equal(widgetFor('text'), 'text');
    assert.equal(widgetFor('image'), 'text');
    assert.equal(widgetFor(undefined), 'text');
});

test('a new flow is given world and world_key, and given them only once', () => {
    const graph = { _nodes: [] };
    const canvas = {
        graph,
        addPseudo(kind) {
            const node = { _irKind: `pseudo-${kind}`, _irName: 'Input' };
            graph._nodes.push(node);
            return node;
        },
    };
    assert.deepEqual(missingWorldInputs(graph), WORLD_INPUTS);
    assert.deepEqual(addWorldInputs(canvas), WORLD_INPUTS);
    assert.deepEqual(graph._nodes.map((n) => n._irName), WORLD_INPUTS);
    assert.deepEqual(addWorldInputs(canvas), []);
    assert.deepEqual(missingWorldInputs(graph), []);
});

test('the two inputs carry a string, which is what the ELX writes', () => {
    const graph = { _nodes: [] };
    const canvas = { graph, addPseudo: (kind) => {
        const node = { _irKind: `pseudo-${kind}` };
        graph._nodes.push(node);
        return node;
    } };
    addWorldInputs(canvas);
    for (const n of graph._nodes) {
        assert.deepEqual(n._irStructure,
            { structure: 'droplet', value: { id: 'string', data: '' } });
    }
});
