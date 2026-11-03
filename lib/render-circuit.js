'use strict';

const renderCell = require('./render-sequential.js');
const {getLabelWidth} = require('logidrom/lib/font-metrics.js');

const gates = ['AND', 'OR', 'XOR', 'NAND', 'NOR', 'XNOR', 'NOT', 'BUF'];
const sequential = ['DFF', 'DLATCH', 'SRLATCH', 'TIMER', 'COUNTER', 'ONESHOT'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const escapeText = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = value => escapeText(value).replace(/"/g, '&quot;');
const fail = message => { throw new Error('Circuit: ' + message); };
const finite = (value, context) => {
    if (!Number.isFinite(value)) { fail(context + ' must be a finite number'); }
    return value;
};
const positive = (value, context) => {
    if (finite(value, context) <= 0) { fail(context + ' must be positive'); }
    return value;
};
const label = (value, context) => {
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
        fail(context + ' must be a nonempty, single-line string');
    }
    return value;
};

function text (x, y, value, attributes = {}) {
    return ['text', {x, y, ...attributes,
        style: 'font-family:monospace;font-size:12px;font-weight:500;fill:#000;stroke:none' + (attributes['text-anchor'] ? ';text-anchor:' + attributes['text-anchor'] : '')
    }, escapeText(value)];
}

function line (x1, y1, x2, y2, attributes = {}) {
    return ['path', {d: 'M' + x1 + ',' + y1 + 'L' + x2 + ',' + y2, fill: 'none', stroke: '#000', 'stroke-width': 1, ...attributes}];
}

function bubble (x, y) {
    return ['circle', {'data-role': 'inversion', cx: x, cy: y, r: 3, fill: '#aaa', stroke: '#000', 'stroke-width': 1}];
}

function measuredPorts (ports, direction, width, ys) {
    return ports.map((port, index) => ({...port,
        id: port.id === undefined ? (port.name === undefined ? direction + index : port.name) : port.id,
        name: port.name === undefined ? (port.id === undefined ? direction + index : port.id) : port.name,
        x: direction === 'IN' ? 0 : width, y: ys[index]
    }));
}

function measureBoundary (node, inputs, outputs) {
    const width = node.width === undefined ? Math.max(80, getLabelWidth(node.label || node.id || '') + 8) : positive(node.width, 'node width');
    const height = node.height === undefined ? 32 : positive(node.height, 'node height');
    return {width, height, body: {x: 0, y: 0, width, height},
        inputs: measuredPorts(inputs, 'IN', width, inputs.map(() => height / 2)),
        outputs: measuredPorts(outputs, 'OUT', width, outputs.map(() => height / 2))};
}

// The layout owner can measure a node before choosing its absolute location.
// This function is pure; no source object or port object is changed.
function measureNode (node) {
    if (!object(node)) { fail('node must be an object'); }
    const type = label(node.type, 'node type').toUpperCase();
    const inputs = node.inputs || [];
    const outputs = node.outputs || [];
    if (!Array.isArray(inputs) || !Array.isArray(outputs)) { fail('node inputs and outputs must be arrays'); }
    if (sequential.includes(type)) {
        if (!object(node.cell)) { fail(type + ' node requires a cell'); }
        const net = outputs[0] ? outputs[0].net : node.output;
        const measured = renderCell(net, node.cell, {connected: true});
        if (node.cell.type.toUpperCase() !== type) { fail('node type must match its cell type'); }
        return measured;
    }
    if (type === 'INPUT' || type === 'OUTPUT') {
        return measureBoundary(node, inputs, outputs);
    }
    if (!gates.includes(type)) { fail('unsupported node type ' + type); }
    const unary = type === 'NOT' || type === 'BUF';
    const width = node.width === undefined ? 72 : positive(node.width, 'node width');
    if (width < 64) { fail('logic gate width must be at least 64'); }
    const bodyHeight = unary ? 32 : Math.max(32, inputs.length * 16);
    const height = 20 + bodyHeight;
    const inputYs = inputs.map((pin, index) => unary ? 36 : 28 + index * 16);
    return {width, height, body: {x: 16, y: 20, width: width - (unary ? 40 : 32), height: bodyHeight},
        inputs: measuredPorts(inputs, 'IN', width, inputYs),
        outputs: measuredPorts(outputs, 'OUT', width, outputs.map(() => 20 + bodyHeight / 2))};
}

function validatePorts (node, kind, expected) {
    const ports = node[kind];
    if (!Array.isArray(ports)) { fail(node.id + '.' + kind + ' must be an array'); }
    if (ports.length !== expected.length) { fail(node.id + '.' + kind + ' does not match symbol geometry'); }
    ports.forEach((port, index) => {
        if (!object(port)) { fail('port must be an object'); }
        label(port.id, 'port id');
        label(port.net, 'port net');
        if (port.name !== undefined) { label(port.name, 'port name'); }
        if (port.inverted !== undefined && typeof port.inverted !== 'boolean') { fail('port inverted must be boolean'); }
        if (finite(port.x, 'port x') !== expected[index].x || finite(port.y, 'port y') !== expected[index].y) {
            fail(node.id + '.' + port.id + ' coordinates must match symbol geometry');
        }
        if (sequential.includes(node.type) && (port.net !== expected[index].net || (port.name || port.id) !== expected[index].name)) {
            fail(node.id + '.' + port.id + ' must match the named cell port and net');
        }
        if (sequential.includes(node.type) && port.inverted !== undefined && port.inverted !== expected[index].inverted) {
            fail(node.id + '.' + port.id + ' polarity must match the cell port');
        }
    });
}

function validatePortCounts (node) {
    if (node.type === 'INPUT' && (node.inputs.length !== 0 || node.outputs.length !== 1)) { fail('INPUT requires one output and no inputs'); }
    if (node.type === 'OUTPUT' && (node.inputs.length !== 1 || node.outputs.length !== 0)) { fail('OUTPUT requires one input and no outputs'); }
    if (gates.includes(node.type) && (node.outputs.length !== 1 || node.inputs.length < 1 || (['NOT', 'BUF'].includes(node.type) && node.inputs.length !== 1))) {
        fail(node.type + ' requires ' + (['NOT', 'BUF'].includes(node.type) ? 'one input' : 'at least one input') + ' and one output');
    }
}

function prepareNodes (nodes, width, height) {
    if (!Array.isArray(nodes) || nodes.length === 0) { fail('nodes must be a nonempty array'); }
    const lookup = new Map();
    const prepared = nodes.map(source => {
        if (!object(source)) { fail('node must be an object'); }
        const node = {...source, type: label(source.type, 'node type').toUpperCase()};
        label(node.id, 'node id');
        if (lookup.has(node.id)) { fail('duplicate node id ' + node.id); }
        if (node.label !== undefined) { label(node.label, 'node label'); }
        finite(node.x, 'node x');
        finite(node.y, 'node y');
        const measured = measureNode(node);
        positive(node.width, 'node width');
        positive(node.height, 'node height');
        if (node.width !== measured.width || node.height !== measured.height) { fail(node.id + ' dimensions must match symbol geometry'); }
        if (node.x < 0 || node.y < 0 || node.x + node.width > width || node.y + node.height > height) { fail(node.id + ' lies outside the circuit bounds'); }
        validatePorts(node, 'inputs', measured.inputs);
        validatePorts(node, 'outputs', measured.outputs);
        const ports = new Map();
        [...node.inputs, ...node.outputs].forEach(port => {
            if (ports.has(port.id)) { fail('duplicate port id ' + node.id + '.' + port.id); }
            ports.set(port.id, port);
        });
        validatePortCounts(node);
        const item = {node, measured, ports};
        lookup.set(node.id, item);
        return item;
    });
    return {prepared, lookup};
}

function endpoint (reference, lookup, direction) {
    if (!object(reference)) { fail('edge ' + direction + ' must be a node/port reference'); }
    const found = lookup.get(label(reference.node, 'edge node'));
    if (!found) { fail('unknown edge node ' + reference.node); }
    const port = found.ports.get(label(reference.port, 'edge port'));
    if (!port) { fail('unknown edge port ' + reference.node + '.' + reference.port); }
    if (!found.node[direction === 'source' ? 'outputs' : 'inputs'].includes(port)) { fail('edge ' + direction + ' references the wrong port direction'); }
    return {net: port.net, x: found.node.x + port.x, y: found.node.y + port.y};
}

function prepareEdges (edges, lookup, width, height) {
    if (!Array.isArray(edges)) { fail('edges must be an array'); }
    const ids = new Set();
    return edges.map(edge => {
        if (!object(edge)) { fail('edge must be an object'); }
        label(edge.id, 'edge id');
        if (ids.has(edge.id)) { fail('duplicate edge id ' + edge.id); }
        ids.add(edge.id);
        label(edge.net, 'edge net');
        const source = endpoint(edge.source, lookup, 'source');
        const target = endpoint(edge.target, lookup, 'target');
        if (source.net !== edge.net || target.net !== edge.net) { fail('edge net must match both port nets'); }
        if (!Array.isArray(edge.points) || edge.points.length < 2) { fail('edge points must have at least two points'); }
        edge.points.forEach((point, index) => {
            if (!object(point)) { fail('edge point must be an object'); }
            finite(point.x, 'edge point x');
            finite(point.y, 'edge point y');
            if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) { fail('edge point lies outside circuit bounds'); }
            if (index && point.x !== edge.points[index - 1].x && point.y !== edge.points[index - 1].y) { fail('edge segments must be orthogonal'); }
        });
        const first = edge.points[0];
        const last = edge.points[edge.points.length - 1];
        if (first.x !== source.x || first.y !== source.y || last.x !== target.x || last.y !== target.y) { fail('edge route endpoints must match source and target ports'); }
        return edge;
    });
}

function prepareSharedInputs (definitions) {
    if (definitions === undefined) { return new Map(); }
    if (!Array.isArray(definitions)) { fail('sharedInputs must be an array'); }
    const shared = new Map();
    definitions.forEach(definition => {
        if (!object(definition)) { fail('shared input must be an object'); }
        if (Object.keys(definition).some(key => !['net', 'symbol'].includes(key))) { fail('unknown shared input field'); }
        label(definition.net, 'shared input net');
        if (!['one', 'clock'].includes(definition.symbol)) { fail('shared input symbol must be one or clock'); }
        if (shared.has(definition.net)) { fail('duplicate shared input net ' + definition.net); }
        shared.set(definition.net, definition);
    });
    return shared;
}

function validateConnections (prepared, edges, shared) {
    const drivers = new Map();
    prepared.forEach(({node}) => node.outputs.forEach(port => {
        if (shared.has(port.net)) { fail('shared input net ' + port.net + ' cannot have an output driver'); }
        if (drivers.has(port.net)) { fail('net ' + port.net + ' has multiple output drivers'); }
        drivers.set(port.net, {node: node.id, port: port.id});
    }));
    const targets = new Map();
    edges.forEach(edge => {
        if (shared.has(edge.net)) { fail('shared input net ' + edge.net + ' cannot have a wire'); }
        if (!targets.has(edge.target.node)) { targets.set(edge.target.node, new Map()); }
        const ports = targets.get(edge.target.node);
        ports.set(edge.target.port, (ports.get(edge.target.port) || 0) + 1);
    });
    const used = new Set();
    prepared.forEach(({node}) => node.inputs.forEach(port => {
        if (shared.has(port.net)) {
            if (node.x < 32) { fail(node.id + ' requires a 32-pixel left gutter for its shared inputs'); }
            used.add(port.net);
            return;
        }
        if (!targets.has(node.id) || targets.get(node.id).get(port.id) !== 1) {
            fail(node.id + '.' + port.id + ' must have exactly one incoming edge');
        }
    }));
    shared.forEach((definition, net) => {
        if (!used.has(net)) { fail('unused shared input net ' + net); }
    });
}

function drawGate (node, measured) {
    const unary = node.type === 'NOT' || node.type === 'BUF';
    const curved = ['OR', 'NOR', 'XOR', 'XNOR'].includes(node.type);
    const xor = node.type === 'XOR' || node.type === 'XNOR';
    const inverted = ['NAND', 'NOR', 'XNOR', 'NOT'].includes(node.type);
    const left = measured.body.x;
    const top = measured.body.y;
    const right = left + measured.body.width;
    const bottom = top + measured.body.height;
    const center = (top + bottom) / 2;
    let d;
    if (unary) {
        d = 'M' + left + ',' + top + 'L' + right + ',' + center + 'L' + left + ',' + bottom + 'Z';
    } else if (curved) {
        d = 'M' + left + ',' + top + 'Q' + (right - 18) + ',' + top + ' ' + right + ',' + center + 'Q' + (right - 18) + ',' + bottom + ' ' + left + ',' + bottom + 'Q' + (left + 12) + ',' + center + ' ' + left + ',' + top + 'Z';
    } else {
        const shoulder = right - 20;
        d = 'M' + left + ',' + top + 'H' + shoulder + 'C' + right + ',' + top + ' ' + right + ',' + (top + measured.body.height / 4) + ' ' + right + ',' + center + 'C' + right + ',' + (bottom - measured.body.height / 4) + ' ' + right + ',' + bottom + ' ' + shoulder + ',' + bottom + 'H' + left + 'Z';
    }
    return ['g', {'data-symbol': node.type},
        ...(node.label ? [text(left, 12, node.label)] : []),
        ['path', {'data-role': 'body', class: 'gate', d, fill: '#aaa', stroke: '#000', 'stroke-width': 1}],
        ...(xor ? [['path', {d: 'M' + (left - 6) + ',' + top + 'Q' + (left + 6) + ',' + center + ' ' + (left - 6) + ',' + bottom, fill: 'none', stroke: '#000', 'stroke-width': 1}]] : []),
        ...node.inputs.map(pin => {
            const t = (pin.y - top) / measured.body.height;
            const face = curved ? left + 24 * t * (1 - t) : left;
            return ['g', {'data-port': escapeAttribute(pin.id)},
                line(pin.x, pin.y, face - (pin.inverted ? 6 : 0), pin.y),
                ...(pin.inverted ? [bubble(face - 3, pin.y)] : [])
            ];
        }),
        ...node.outputs.map(pin => ['g', {'data-port': escapeAttribute(pin.id), 'data-role': 'output'},
            line(right + (inverted ? 6 : 0), center, pin.x, pin.y),
            ...(inverted ? [bubble(right + 3, center)] : [])
        ])
    ];
}

function clockMark (x, y) {
    return ['path', {d: 'M' + x + ',' + y + 'h5v-4h8v8h7v-4', fill: 'none', stroke: '#000', 'stroke-width': 1}];
}

function drawSharedInput (port, definition) {
    const {x, y} = port;
    const mark = definition.symbol === 'one'
        ? [text(x - 12, y + 4, '1', {'text-anchor': 'middle'}), line(x - 6, y, x, y)]
        : [clockMark(x - 26, y),
            line(x - 6, y, x, y)];
    return ['g', {class: 'circuit-shared', 'data-shared-net': escapeAttribute(port.net), 'data-port': escapeAttribute(port.id)},
        ['title', {}, escapeText(port.net + (definition.symbol === 'one' ? ' (shared logic 1)' : ' (shared clock)'))],
        ...mark];
}

function drawSharedLegend (shared, titled) {
    return [...shared.values()].map((definition, index) => {
        const y = (titled ? 44 : 24) + index * 16;
        return ['g', {class: 'circuit-shared-legend'},
            ...(definition.symbol === 'one' ? [text(20, y, '1 = ' + definition.net)]
                : [clockMark(20, y - 4), line(40, y - 4, 46, y - 4), text(54, y, '= ' + definition.net)])];
    });
}

function drawNode (item, shared) {
    const {node, measured} = item;
    let symbol;
    if (sequential.includes(node.type)) {
        symbol = measured.svg;
    } else if (gates.includes(node.type)) {
        symbol = drawGate(node, measured);
    } else {
        symbol = ['g', {'data-symbol': node.type},
            ['rect', {'data-role': 'body', width: node.width, height: node.height, fill: '#eee', stroke: '#ccc', 'stroke-width': 1}],
            text(node.width / 2, node.height / 2 + 4, node.label || node.id, {'text-anchor': 'middle'})
        ];
    }
    return ['g', {'data-node': escapeAttribute(node.id), transform: 'translate(' + node.x + ',' + node.y + ')'},
        ['title', {}, escapeText(JSON.stringify(node))], symbol,
        ...node.inputs.filter(port => shared.has(port.net)).map(port => drawSharedInput(port, shared.get(port.net)))];
}

function drawNets (edges, junctions) {
    const groups = new Map();
    edges.forEach(edge => {
        if (!groups.has(edge.net)) { groups.set(edge.net, []); }
        groups.get(edge.net).push(edge);
    });
    const path = edge => edge.points.map((point, index) => (index ? 'L' : 'M') + point.x + ',' + point.y).join('');
    return [...groups].map(([net, routes]) => ['g', {class: 'circuit-net', 'data-net': escapeAttribute(net)},
        ['title', {}, escapeText(net)],
        ...routes.map(edge => ['path', {class: 'circuit-wire-underlay', d: path(edge), fill: 'none', stroke: '#fff', 'stroke-width': 3}]),
        ...routes.map(edge => ['path', {class: 'circuit-wire', 'data-edge': escapeAttribute(edge.id),
            'data-source-node': escapeAttribute(edge.source.node), 'data-source-port': escapeAttribute(edge.source.port),
            'data-target-node': escapeAttribute(edge.target.node), 'data-target-port': escapeAttribute(edge.target.port),
            'data-source-x': edge.points[0].x, 'data-source-y': edge.points[0].y,
            'data-target-x': edge.points[edge.points.length - 1].x, 'data-target-y': edge.points[edge.points.length - 1].y,
            d: path(edge), fill: 'none', stroke: '#000', 'stroke-width': 1}]),
        ...junctions.filter(point => point.net === net).map(point => ['circle', {class: 'circuit-junction', 'data-role': 'junction',
            'data-net': escapeAttribute(net), cx: point.x, cy: point.y, r: 2, fill: '#000', stroke: 'none'}])
    ]);
}

function renderCircuit (index, source) {
    if (!object(source.circuit)) { fail('circuit must be an object'); }
    if (source.title !== undefined) { label(source.title, 'title'); }
    const circuit = source.circuit;
    const width = positive(circuit.width, 'circuit width');
    const height = positive(circuit.height, 'circuit height');
    const {prepared, lookup} = prepareNodes(circuit.nodes, width, height);
    const edges = prepareEdges(circuit.edges, lookup, width, height);
    const shared = prepareSharedInputs(circuit.sharedInputs);
    validateConnections(prepared, edges, shared);
    const junctions = circuit.junctions === undefined ? [] : circuit.junctions;
    if (!Array.isArray(junctions)) { fail('junctions must be an array'); }
    junctions.forEach(point => {
        if (!object(point)) { fail('junction must be an object'); }
        label(point.net, 'junction net');
        finite(point.x, 'junction x');
        finite(point.y, 'junction y');
        if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) { fail('junction lies outside circuit bounds'); }
        const touching = edges.filter(edge => edge.net === point.net && edge.points.slice(1).some((end, i) => {
            const start = edge.points[i];
            return start.x === end.x ? point.x === start.x && point.y >= Math.min(start.y, end.y) && point.y <= Math.max(start.y, end.y)
                : point.y === start.y && point.x >= Math.min(start.x, end.x) && point.x <= Math.max(start.x, end.x);
        }));
        if (touching.length < 2) { fail('junction must join at least two routes of its net'); }
    });
    return ['svg', {id: escapeAttribute('svgcontent_' + index), width, height, viewBox: '0 0 ' + width + ' ' + height, fill: '#000'},
        ['style', {}, '.circuit-net:hover .circuit-wire{stroke:#087ac1;stroke-width:2}.circuit-net:hover .circuit-junction{fill:#087ac1}.circuit-net:hover,.circuit-shared:hover{cursor:crosshair}.circuit-shared:hover path{stroke:#087ac1}.circuit-shared:hover text{fill:#087ac1!important}'],
        ['rect', {width, height, fill: '#fff', stroke: 'none'}],
        ...(source.title ? [text(20, 24, source.title)] : []),
        ...drawSharedLegend(shared, source.title !== undefined),
        ...drawNets(edges, junctions),
        ...prepared.map(item => drawNode(item, shared))
    ];
}

renderCircuit.measureNode = measureNode;
module.exports = renderCircuit;
