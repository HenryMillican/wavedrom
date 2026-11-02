/* global describe, it */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const json5 = require('json5');
const {parse, stringify} = require('onml');
const renderAny = require('../lib/render-any.js');
const renderCell = require('../lib/render-sequential.js');
const compileCircuit = require('../lib/compile-circuit.js');
const waveSkin = require('../skins/default.js');

const fixture = () => json5.parse(fs.readFileSync(path.join(__dirname, 'connected-circuit.json5'), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const attrs = node => node[1] && !Array.isArray(node[1]) && typeof node[1] === 'object' ? node[1] : {};

function nodes (tree, predicate) {
    const result = [];
    function visit (node) {
        if (!Array.isArray(node)) return;
        if (typeof node[0] === 'string' && predicate(node, attrs(node))) result.push(node);
        node.forEach(child => { if (Array.isArray(child)) visit(child); });
    }
    visit(tree);
    return result;
}

const by = (tree, name, value) => nodes(tree, (node, attributes) => attributes[name] === value);
const visibleText = tree => nodes(tree, node => node[0] === 'text').map(node => node.slice(2).join('')).join(' ');

function freeze (value) {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        Object.values(value).forEach(freeze);
    }
    return value;
}

function checkConnections (graph) {
    const indexed = new Map(graph.nodes.map(node => [node.id, node]));
    for (const edge of graph.edges) {
        const source = indexed.get(edge.source.node);
        const target = indexed.get(edge.target.node);
        assert.ok(source && target, 'Every edge must connect existing nodes');
        const output = source.outputs.find(port => port.id === edge.source.port);
        const input = target.inputs.find(port => port.id === edge.target.port);
        assert.ok(output && input, 'Every edge must connect an output to an input');
        assert.equal(output.net, edge.net);
        assert.equal(input.net, edge.net);
        assert.deepEqual(edge.points[0], {x: source.x + output.x, y: source.y + output.y});
        assert.deepEqual(edge.points[edge.points.length - 1], {x: target.x + input.x, y: target.y + input.y});
        for (let index = 0; index < edge.points.length; index++) {
            const point = edge.points[index];
            assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
            assert.ok(point.x >= 0 && point.y >= 0 && point.x <= graph.width && point.y <= graph.height);
            if (index > 0) {
                const previous = edge.points[index - 1];
                assert.ok(previous.x === point.x || previous.y === point.y, 'Wires must be orthogonal');
            }
        }
    }
    for (const node of graph.nodes) {
        for (const port of node.inputs) {
            assert.equal(graph.edges.filter(edge => edge.target.node === node.id && edge.target.port === port.id).length, 1,
                node.id + '.' + port.id + ' must have exactly one wire');
        }
    }
}

describe('connected circuit diagrams', function () {
    it('draws the complete generic circuit with physical wires and no internal net-name boxes', function () {
        const source = fixture();
        checkConnections(source.circuit);
        const svg = renderAny(0, source, waveSkin);
        assert.equal(svg[0], 'svg');
        assert.equal(attrs(svg).class, 'WaveDrom');
        for (const node of source.circuit.nodes) assert.equal(by(svg, 'data-node', node.id).length, 1);
        for (const edge of source.circuit.edges) {
            const wires = by(svg, 'data-net', edge.net).filter(node => node[0] === 'g');
            assert.ok(wires.length > 0, 'Expected a wire for ' + edge.net);
            assert.ok(nodes(wires, node => node[0] === 'path' || node[0] === 'polyline').length > 0);
        }
        assert.equal(by(svg, 'data-role', 'net-label').length, 0);
        assert.ok(!visibleText(svg).includes('capture_data'));
        assert.ok(visibleText(svg).includes('captured'));
        assert.ok(nodes(svg, node => node[0] === 'title').some(node => node.slice(2).join('').includes('capture_data')));
        assert.equal(by(svg, 'data-symbol', 'DFF').length, 1);
    });

    it('renders frozen source data without mutation', function () {
        const source = fixture();
        const before = clone(source);
        renderAny(3, freeze(source), waveSkin);
        assert.deepEqual(source, before);
    });

    it('shows only explicit identifiers above Boolean gates', function () {
        const source = fixture();
        const unlabeled = renderAny(0, source, waveSkin);
        assert.ok(!visibleText(by(unlabeled, 'data-node', 'G1')).includes('G1'));
        source.circuit.nodes.find(node => node.id === 'G1').label = 'AND1';
        const labeled = renderAny(0, source, waveSkin);
        assert.ok(visibleText(by(labeled, 'data-node', 'G1')).includes('AND1'));
    });

    it('draws explicit branch dots and keeps a crossing of different nets unjoined', function () {
        const source = fixture();
        source.circuit.nodes = source.circuit.nodes.filter(node => node.id !== 'valid');
        source.circuit.nodes.find(node => node.id === 'G1').inputs[1].net = 'clk';
        const branch = source.circuit.edges.find(edge => edge.id === 'valid-G1');
        branch.net = 'clk';
        branch.source = {node: 'clock', port: 'OUT'};
        branch.points = [{x: 100, y: 180}, {x: 140, y: 180}, {x: 140, y: 76}, {x: 180, y: 76}];
        source.circuit.junctions = [{net: 'clk', x: 140, y: 180}];
        const svg = renderAny(0, source, waveSkin);
        const dots = by(svg, 'data-role', 'junction');
        assert.equal(dots.length, 1);
        assert.equal(dots[0][0], 'circle');
        assert.equal(attrs(dots[0])['data-net'], 'clk');
        assert.equal(Number(attrs(dots[0]).cx), 140);
        assert.equal(Number(attrs(dots[0]).cy), 180);
        const net = by(svg, 'data-net', 'clk').find(node => node[0] === 'g');
        assert.equal(by(net, 'data-role', 'junction').length, 1, 'A branch dot belongs to its net hover/render group');
        assert.equal(by(svg, 'data-role', 'junction').filter(node => svg.includes(node)).length, 0);

        const crossing = fixture();
        crossing.circuit.edges.find(edge => edge.id === 'clock-U1').points = [
            {x: 100, y: 180}, {x: 160, y: 180}, {x: 160, y: 40},
            {x: 280, y: 40}, {x: 280, y: 84}, {x: 320, y: 84}
        ];
        const crossed = renderAny(0, crossing, waveSkin);
        assert.equal(by(crossed, 'data-role', 'junction').length, 0);
        assert.ok(by(crossed, 'data-net', 'enable').length > 0);
        assert.ok(by(crossed, 'data-net', 'clk').length > 0);
    });

    it('keeps edge, polarity and asynchronous markings when net labels are removed', function () {
        const definition = {type: 'DFF', id: 'U1', edge: 'falling', complement: 'q_n', inputs: {
            D: 'data', CLK: 'clk_n', RESET: {net: 'reset_n', active: 'low'}
        }};
        const before = clone(definition);
        const compact = renderCell('q', freeze(definition), {connected: true});
        assert.deepEqual(definition, before);
        assert.equal(by(compact.svg, 'data-role', 'net-label').length, 0);
        assert.equal(by(compact.svg, 'data-role', 'clock-edge').length, 1);
        assert.equal(by(compact.svg, 'data-role', 'inversion').length, 3);
        assert.equal(by(compact.svg, 'data-asynchronous', 'true').length, 1);
        assert.deepEqual(compact.inputs.map(port => [port.id, port.net, port.inverted]),
            [['D', 'data', false], ['CLK', 'clk_n', true], ['RESET', 'reset_n', true]]);
        assert.deepEqual(compact.outputs.map(port => [port.id, port.net, port.inverted]),
            [['Q', 'q', false], ['QN', 'q_n', true]]);
        assert.ok(by(renderCell('q', definition).svg, 'data-role', 'net-label').length > 0);
    });

    it('returns finite connectable geometry for every sequential symbol', function () {
        const inputs = {
            DFF: {D: 'data', CLK: 'clk'}, DLATCH: {D: 'data', EN: 'enable'},
            SRLATCH: {S: 'set', R: 'reset'}, TIMER: {IN: 'enable'},
            COUNTER: {CLK: 'clk'}, ONESHOT: {IN: 'trigger'}
        };
        for (const [type, ports] of Object.entries(inputs)) {
            const result = renderCell('result', {type, inputs: ports}, {connected: true});
            assert.equal(by(result.svg, 'data-symbol', type).length, 1);
            assert.equal(by(result.svg, 'data-role', 'net-label').length, 0);
            for (const port of [...result.inputs, ...result.outputs]) {
                assert.ok(Number.isFinite(port.x) && Number.isFinite(port.y));
                assert.ok(port.x >= 0 && port.x <= result.width && port.y >= 0 && port.y <= result.height);
            }
        }
    });

    it('escapes user labels and net hover text in SVG', function () {
        const source = fixture();
        const malicious = '<script>& payload';
        source.title = malicious;
        source.circuit.nodes[0].label = malicious;
        source.circuit.nodes[0].outputs[0].net = malicious;
        source.circuit.nodes[3].inputs[0].net = malicious;
        source.circuit.edges[0].net = malicious;
        const xml = stringify(renderAny(0, source, waveSkin));
        const svg = parse(xml);
        assert.ok(xml.includes('&lt;script&gt;'));
        assert.equal(nodes(svg, node => node[0] === 'script').length, 0);
        assert.ok(visibleText(svg).includes(malicious));
    });

    const invalid = [
        ['missing source node', source => { source.circuit.edges[0].source.node = 'missing'; }],
        ['missing target port', source => { source.circuit.edges[0].target.port = 'missing'; }],
        ['wrong endpoint net', source => { source.circuit.edges[0].net = 'wrong'; }],
        ['unrouted edge', source => { source.circuit.edges[0].points = []; }],
        ['incorrect route endpoint', source => { source.circuit.edges[0].points[0].x += 1; }],
        ['diagonal route', source => { source.circuit.edges[3].points[1].x += 1; }],
        ['nonfinite route coordinate', source => { source.circuit.edges[0].points[0].x = Infinity; }],
        ['out-of-bounds node', source => { source.circuit.nodes[0].x = -1; }],
        ['out-of-bounds route', source => { source.circuit.edges[3].points[1].y = 221; }],
        ['duplicate node ID', source => { source.circuit.nodes[1].id = source.circuit.nodes[0].id; }],
        ['duplicate edge ID', source => { source.circuit.edges[1].id = source.circuit.edges[0].id; }],
        ['unconnected input port', source => { source.circuit.edges.shift(); }],
        ['two edges feeding one input port', source => { source.circuit.edges.push({...clone(source.circuit.edges[0]), id: 'duplicate-target'}); }],
        ['multiple output drivers for one net', source => {
            const extra = clone(source.circuit.nodes[0]);
            extra.id = 'other-enable-driver';
            extra.x = 20;
            extra.y = 124;
            source.circuit.nodes.push(extra);
        }],
        ['nonpositive canvas', source => { source.circuit.width = 0; }]
    ];
    for (const [description, change] of invalid) {
        it('rejects ' + description, function () {
            const source = fixture();
            change(source);
            assert.throws(() => renderAny(0, source, waveSkin));
        });
    }
});

describe('connected circuit compiler', function () {
    it('routes mixed gate and sequential assignments without changing the source', async function () {
        const source = {title: 'Capture', assign: [
            ['capture_data', ['&', 'enable', 'valid']],
            ['captured', {type: 'DFF', id: 'U1', inputs: {D: 'capture_data', CLK: 'clk'}}]
        ]};
        const before = clone(source);
        const result = await compileCircuit(freeze(source));
        assert.deepEqual(source, before);
        checkConnections(result.circuit);
        assert.ok(result.circuit.nodes.some(node => node.type === 'AND'));
        assert.ok(result.circuit.nodes.some(node => node.type === 'DFF'));
        const svg = renderAny(0, result, waveSkin);
        assert.equal(by(svg, 'data-role', 'net-label').length, 0);
        assert.equal(by(svg, 'data-symbol', 'DFF').length, 1);
    });

    it('keeps a shared source as one net feeding several real input wires', async function () {
        const result = await compileCircuit({assign: [
            ['combined', ['&', 'shared', 'other']],
            ['captured', {type: 'DFF', inputs: {D: 'combined', CLK: 'shared'}}]
        ]});
        checkConnections(result.circuit);
        const shared = result.circuit.edges.filter(edge => edge.net === 'shared');
        assert.equal(shared.length, 2);
        assert.equal(new Set(shared.map(edge => edge.source.node + '.' + edge.source.port)).size, 1);
        renderAny(0, result, waveSkin);
    });

    it('connects sequential pins by name regardless of input-object key order', async function () {
        const result = await compileCircuit({assign: [['q', {
            type: 'DFF', complement: 'q_n',
            inputs: {RESET: {net: 'reset_n', active: 'low'}, CLK: 'clk', D: 'data'}
        }]]});
        checkConnections(result.circuit);
        const dff = result.circuit.nodes.find(node => node.type === 'DFF');
        assert.deepEqual(dff.inputs.map(port => [port.name, port.net]),
            [['D', 'data'], ['CLK', 'clk'], ['RESET', 'reset_n']]);
        const svg = renderAny(0, result, waveSkin);
        assert.equal(by(svg, 'data-role', 'inversion').length, 2);
    });

    it('places and connects every supported gate and sequential component', async function () {
        const gates = [['AND', '&'], ['OR', '|'], ['XOR', '^'], ['NAND', '~&'],
            ['NOR', '~|'], ['XNOR', '~^'], ['NOT', '~'], ['BUF', '=']];
        const ports = {
            DFF: {D: 'data', CLK: 'clk'}, DLATCH: {D: 'data', EN: 'enable'},
            SRLATCH: {S: 'set', R: 'reset'}, TIMER: {IN: 'enable'},
            COUNTER: {CLK: 'clk'}, ONESHOT: {IN: 'trigger'}
        };
        const assign = gates.map(([type, operator]) => [type.toLowerCase(),
            ['NOT', 'BUF'].includes(type) ? [operator, 'a'] : [operator, 'a', 'b']]);
        for (const [type, inputs] of Object.entries(ports)) assign.push([type.toLowerCase(), {type, inputs}]);
        const result = await compileCircuit({assign});
        checkConnections(result.circuit);
        const svg = renderAny(0, result, waveSkin);
        for (const type of [...gates.map(([type]) => type), ...Object.keys(ports)]) {
            assert.equal(by(svg, 'data-symbol', type).length, 1);
        }
    });

    it('normalizes aliases and lowercase component types without changing their source', async function () {
        const cases = [
            ['d_ff', 'DFF', {D: 'data', CLK: 'clk'}],
            ['latch', 'DLATCH', {D: 'data', EN: 'enable'}],
            ['sr_latch', 'SRLATCH', {S: 'set', R: 'reset'}],
            ['timer', 'TIMER', {IN: 'enable'}]
        ];
        const source = {assign: cases.map(([type, , inputs], index) => ['q' + index, {type, inputs}])};
        const before = clone(source);
        const result = await compileCircuit(freeze(source));
        assert.deepEqual(source, before);
        checkConnections(result.circuit);
        for (let index = 0; index < cases.length; index++) {
            const node = result.circuit.nodes.find(candidate => candidate.assignment === 'q' + index);
            assert.equal(node.type, cases[index][1]);
            assert.equal(node.cell.type, cases[index][1]);
            assert.equal(node.outputs[0].name, node.type === 'TIMER' ? 'OUT' : 'Q');
        }
    });

    it('keeps an external generated-prefix net separate from nested gate outputs', async function () {
        const result = await compileCircuit({assign: [
            ['q', ['|', '__wavedrom_0', ['&', 'a', 'b']]]
        ]});
        checkConnections(result.circuit);
        const external = result.circuit.nodes.filter(node => node.type === 'INPUT' && node.outputs[0].net === '__wavedrom_0');
        assert.equal(external.length, 1);
        const nested = result.circuit.nodes.find(node => node.type === 'AND');
        assert.notEqual(nested.outputs[0].net, '__wavedrom_0');
        const combined = result.circuit.nodes.find(node => node.type === 'OR');
        assert.deepEqual(new Set(combined.inputs.map(port => port.net)), new Set(['__wavedrom_0', nested.outputs[0].net]));
        assert.equal(result.circuit.edges.filter(edge => edge.net === '__wavedrom_0').length, 1);
    });

    it('accepts prototype-property names as ordinary nets and shows supplied sequential labels', async function () {
        const result = await compileCircuit({assign: [
            ['constructor', ['&', 'toString', 'valueOf']],
            ['captured', {type: 'DFF', inputs: {D: 'constructor', CLK: 'hasOwnProperty'}}]
        ]}, {labels: {captured: 'Capture FF'}});
        checkConnections(result.circuit);
        const svg = renderAny(0, result, waveSkin);
        assert.ok(visibleText(svg).includes('toString'));
        assert.ok(visibleText(svg).includes('valueOf'));
        assert.ok(visibleText(svg).includes('hasOwnProperty'));
        assert.ok(visibleText(svg).includes('Capture FF'));
    });

    it('rejects duplicate drivers, unknown operators and missing requested outputs', async function () {
        await assert.rejects(() => compileCircuit({assign: [['q', ['&', 'a', 'b']], ['q', ['|', 'a', 'b']]]}));
        await assert.rejects(() => compileCircuit({assign: [['q', ['unsupported', 'a']]]}));
        await assert.rejects(() => compileCircuit({assign: [['q', ['&', 'a', 'b']]]}, {outputs: [{net: 'missing', label: 'missing'}]}));
    });
});
