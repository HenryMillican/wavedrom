/* global describe, it */
'use strict';

const assert = require('node:assert/strict');
const {parse, stringify} = require('onml');
const renderCircuit = require('../lib/render-circuit.js');
const compileCircuit = require('../lib/compile-circuit.js');

const clone = value => JSON.parse(JSON.stringify(value));
const attrs = node => node[1] && !Array.isArray(node[1]) && typeof node[1] === 'object' ? node[1] : {};

function select (tree, attribute, value) {
    const result = [];
    function visit (node) {
        if (!Array.isArray(node)) { return; }
        if (attrs(node)[attribute] === value) { result.push(node); }
        node.forEach(child => { if (Array.isArray(child)) { visit(child); } });
    }
    visit(tree);
    return result;
}

function freeze (value) {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        Object.values(value).forEach(freeze);
    }
    return value;
}

// Six tied-HIGH data inputs and seven common-clock timer inputs. Other
// controls remain ordinary routed wires, including LOW-active DFF resets.
function fixture () {
    const circuit = {width: 640, height: 1200, nodes: [{
        id: 'capture', type: 'INPUT', label: 'capture', x: 40, y: 20, width: 80, height: 32,
        inputs: [], outputs: [{id: 'OUT', name: 'OUT', net: 'capture', x: 80, y: 16}]
    }], edges: [], junctions: [], sharedInputs: [
        {net: 'HIGH', symbol: 'one'}, {net: 'OSC0', symbol: 'clock'}
    ]};
    for (let index = 0; index < 13; index++) {
        const id = 'U' + index;
        const cell = index < 6
            ? {type: 'DFF', id, edge: index === 0 ? 'falling' : 'rising', initial: 0,
                inputs: {D: 'HIGH', CLK: 'capture', RESET: {net: 'capture', active: 'low'}}}
            : {type: 'TIMER', id, mode: 'on-delay', count: 2, divider: 1,
                inputs: {IN: 'capture', CLK: 'OSC0'}};
        const geometry = renderCircuit.measureNode({type: cell.type, cell, outputs: [{net: 'q' + index}]});
        const node = {id, type: cell.type, cell, x: 240 + (index % 2) * 200,
            y: 80 + Math.floor(index / 2) * 150, width: geometry.width, height: geometry.height,
            inputs: geometry.inputs.map(port => ({...port, id: id + '.' + port.name})),
            outputs: geometry.outputs.map(port => ({...port, id: id + '.' + port.name}))};
        circuit.nodes.push(node);
        node.inputs.filter(port => port.net === 'capture').forEach(port => {
            const y = node.y + port.y;
            circuit.edges.push({id: 'capture-' + port.id, net: 'capture',
                source: {node: 'capture', port: 'OUT'}, target: {node: id, port: port.id},
                points: [{x: 120, y: 36}, {x: 180, y: 36}, {x: 180, y}, {x: node.x, y}]});
        });
    }
    return {circuit};
}

describe('shared circuit inputs', function () {
    it('draws all 13 local source references without adding long wires or source nodes', function () {
        const source = fixture();
        const before = clone(source);
        const svg = renderCircuit(0, freeze(source));
        assert.deepEqual(source, before);
        const high = select(svg, 'data-shared-net', 'HIGH');
        const clocks = select(svg, 'data-shared-net', 'OSC0');
        assert.equal(high.length, 6);
        assert.equal(clocks.length, 7);
        assert.equal(select(svg, 'class', 'circuit-shared').length, 13);
        assert.equal(select(svg, 'class', 'circuit-wire').length, source.circuit.edges.length);
        for (const terminal of [...high, ...clocks]) {
            assert.ok(attrs(terminal)['data-port']);
            assert.ok(terminal.some(child => Array.isArray(child) && child[0] === 'title'));
            const stub = terminal.find(child => Array.isArray(child) && child[0] === 'path' && attrs(child).d.endsWith('L0,' +
                source.circuit.nodes.flatMap(node => node.inputs).find(port => port.id === attrs(terminal)['data-port']).y));
            assert.ok(stub, 'The local source must physically join its named input terminal');
        }
        assert.ok(high.every(terminal => terminal.some(child => Array.isArray(child) && child[0] === 'text' && child[2] === '1')));
        assert.ok(clocks.every(terminal => terminal.filter(child => Array.isArray(child) && child[0] === 'path').length === 2));
    });

    it('retains reset polarity, falling clock edge, timer modes and all original control ports', function () {
        const source = fixture();
        const svg = renderCircuit(0, source);
        assert.equal(select(svg, 'data-symbol', 'DFF').length, 6);
        assert.equal(select(svg, 'data-symbol', 'TIMER').length, 7);
        assert.equal(select(svg, 'data-role', 'clock-edge').length, 6);
        assert.equal(select(svg, 'data-role', 'inversion').length, 7);
        assert.equal(select(svg, 'data-asynchronous', 'true').length, 6);
        for (const node of source.circuit.nodes.filter(node => node.cell)) {
            const drawn = select(svg, 'data-node', node.id)[0];
            for (const port of node.inputs) assert.ok(select(drawn, 'data-port', port.id).length > 0 ||
                select(drawn, 'data-port', port.name).length > 0, 'Control port must remain visible: ' + port.id);
        }
    });

    it('names the shared sources once in an SVG legend below the title', function () {
        const source = fixture();
        source.title = 'Capture and delay';
        const svg = renderCircuit(0, source);
        const legends = select(svg, 'class', 'circuit-shared-legend');
        assert.equal(legends.length, 2);
        const one = legends[0].find(child => Array.isArray(child) && child[0] === 'text');
        const clock = legends[1].find(child => Array.isArray(child) && child[0] === 'text');
        assert.equal(one[2], '1 = HIGH');
        assert.equal(clock[2], '= OSC0');
        assert.equal(attrs(one).y, 44);
        assert.equal(attrs(clock).y, 60);
        assert.ok(legends[1].some(child => Array.isArray(child) && child[0] === 'path'));
        assert.equal(select(svg, 'class', 'circuit-shared').length, 13);
    });

    it('escapes shared net attributes and hover titles', function () {
        const source = fixture();
        const net = '<HIGH "&>';
        source.circuit.sharedInputs[0].net = net;
        for (const node of source.circuit.nodes.filter(node => node.type === 'DFF')) {
            node.cell.inputs.D = net;
            node.inputs.find(port => port.name === 'D').net = net;
        }
        const xml = stringify(renderCircuit(0, source));
        const parsed = parse(xml);
        assert.equal(select(parsed, 'data-shared-net', net).length, 6);
        assert.ok(xml.includes('&lt;HIGH &quot;&amp;&gt;'));
        assert.ok(!xml.includes('<HIGH'));
    });

    const invalid = [
        ['a non-array definition list', source => { source.circuit.sharedInputs = {}; }],
        ['a non-object definition', source => { source.circuit.sharedInputs[0] = 'HIGH'; }],
        ['an empty shared net', source => { source.circuit.sharedInputs[0].net = ''; }],
        ['an unsupported symbol', source => { source.circuit.sharedInputs[0].symbol = 'ground'; }],
        ['an unknown shared-input field', source => { source.circuit.sharedInputs[0].symobl = 'one'; }],
        ['duplicate shared nets', source => { source.circuit.sharedInputs.push({net: 'HIGH', symbol: 'one'}); }],
        ['an unused shared source', source => { source.circuit.sharedInputs.push({net: 'unused', symbol: 'clock'}); }],
        ['a shared net with an output driver and physical wires', source => { source.circuit.sharedInputs.push({net: 'capture', symbol: 'clock'}); }],
        ['a missing ordinary control wire', source => { source.circuit.edges.shift(); }],
        ['an unreserved left gutter', source => {
            source.circuit.nodes[1].x = 31;
            source.circuit.edges.filter(edge => edge.target.node === 'U0').forEach(edge => { edge.points[edge.points.length - 1].x = 31; });
        }]
    ];
    for (const [description, change] of invalid) {
        it('rejects ' + description, function () {
            const source = fixture();
            change(source);
            assert.throws(() => renderCircuit(0, source));
        });
    }
});

describe('shared input circuit compilation', function () {
    it('preserves all 13 shared references while removing only their external wires and drivers', async function () {
        const raw = fixture();
        const source = {assign: raw.circuit.nodes.filter(node => node.cell).map(node => [node.outputs[0].net, node.cell])};
        const options = {sharedInputs: raw.circuit.sharedInputs, outputs: [], boundaryPlacement: 'near'};
        const before = clone({source, options});
        const local = await compileCircuit(freeze(source), freeze(options));
        const wired = await compileCircuit(source, {outputs: [], boundaryPlacement: 'near'});
        assert.deepEqual({source, options}, before);
        assert.equal(local._connectivity.sharedConnections, 13);
        assert.equal(wired.circuit.edges.length - local.circuit.edges.length, 13);
        assert.equal(wired.circuit.nodes.length - local.circuit.nodes.length, 2);
        const sharedNets = new Set(['HIGH', 'OSC0']);
        assert.ok(!local.circuit.edges.some(edge => sharedNets.has(edge.net)));
        assert.ok(!local.circuit.nodes.some(node => node.outputs.some(port => sharedNets.has(port.net))));
        for (const node of local.circuit.nodes) {
            const full = wired.circuit.nodes.find(other => other.assignment === node.assignment && other.type === node.type);
            assert.ok(full);
            assert.deepEqual(node.inputs.map(port => [port.name, port.net, port.inverted]),
                full.inputs.map(port => [port.name, port.net, port.inverted]));
            for (const port of node.inputs) {
                const wires = local.circuit.edges.filter(edge => edge.target.node === node.id && edge.target.port === port.id).length;
                assert.equal(wires + Number(sharedNets.has(port.net)), 1);
                if (sharedNets.has(port.net)) { assert.ok(node.x >= 32); }
            }
        }
        const svg = renderCircuit(0, local);
        assert.equal(select(svg, 'class', 'circuit-shared').length, 13);
    });

    it('supports a circuit whose only input sources are shared terminals', async function () {
        const result = await compileCircuit({assign: [['q', {type: 'DFF', inputs: {D: 'HIGH', CLK: 'OSC0'}}]]}, {
            outputs: [], sharedInputs: [{net: 'HIGH', symbol: 'one'}, {net: 'OSC0', symbol: 'clock'}]
        });
        assert.equal(result.circuit.edges.length, 0);
        assert.equal(result.circuit.nodes.length, 1);
        assert.equal(result._connectivity.sharedConnections, 2);
        assert.equal(select(renderCircuit(0, result), 'class', 'circuit-shared').length, 2);
    });

    it('rejects shared sources that are unused, internally driven, duplicated or unsupported', async function () {
        const source = {assign: [['q', ['&', 'a', 'b']]]};
        for (const sharedInputs of [
            [{net: 'unused', symbol: 'one'}],
            [{net: 'q', symbol: 'one'}],
            [{net: 'a', symbol: 'one'}, {net: 'a', symbol: 'one'}],
            [{net: 'a', symbol: 'unknown'}]
        ]) { await assert.rejects(() => compileCircuit(source, {sharedInputs})); }
    });
});
