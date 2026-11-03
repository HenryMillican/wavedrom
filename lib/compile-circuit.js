'use strict';

const ELK = require('elkjs/lib/elk.bundled.js');
const renderCircuit = require('./render-circuit.js');

const operators = {'&': 'AND', '|': 'OR', '^': 'XOR', '~&': 'NAND', '~|': 'NOR', '~^': 'XNOR', '~': 'NOT', '=': 'BUF'};
const complements = {AND: 'NAND', OR: 'NOR', XOR: 'XNOR', NAND: 'AND', NOR: 'OR', XNOR: 'XOR', NOT: 'BUF', BUF: 'NOT'};
const copy = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error('Connected circuit: ' + message); };
const own = (map, key) => Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

function port (node, name, net, inverted = false) {
    return {id: node + '.' + name, name, net, inverted};
}

function primitive (operator) {
    if (typeof operator !== 'string') { fail('operator must be a string'); }
    const type = operators[operator] || operator.toUpperCase();
    if (!['AND', 'OR', 'XOR', 'NAND', 'NOR', 'XNOR', 'NOT', 'BUF'].includes(type)) {
        fail('unsupported operator ' + operator);
    }
    return type;
}

function junctions (edges) {
    const groups = new Map();
    for (const edge of edges) {
        if (!groups.has(edge.net)) { groups.set(edge.net, []); }
        groups.get(edge.net).push(edge.points);
    }
    const result = [];
    for (const [net, routes] of groups) {
        if (routes.length < 2) { continue; }
        const segments = routes.flatMap(points => points.slice(1).map((b, index) => ({a: points[index], b})));
        const candidates = new Map();
        for (const points of routes) {
            for (const p of points) { candidates.set(p.x + ',' + p.y, p); }
        }
        for (const point of candidates.values()) {
            const directions = new Set();
            for (const {a, b} of segments) {
                if (a.x === b.x && point.x === a.x && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y)) {
                    if (Math.min(a.y, b.y) < point.y) { directions.add('N'); }
                    if (Math.max(a.y, b.y) > point.y) { directions.add('S'); }
                }
                if (a.y === b.y && point.y === a.y && point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x)) {
                    if (Math.min(a.x, b.x) < point.x) { directions.add('W'); }
                    if (Math.max(a.x, b.x) > point.x) { directions.add('E'); }
                }
            }
            if (directions.size > 2) { result.push({net, x: point.x, y: point.y}); }
        }
    }
    return result;
}

/**
 * Compile named assignments into a connected circuit and orthogonal routes.
 * Layout is async in Node; the resulting WaveJSON renders synchronously in the
 * browser and CLI. Layout options affect presentation, never Boolean behavior.
 */
async function compileCircuit (source, options = {}) {
    if (!source || !Array.isArray(source.assign) || source.assign.length === 0) {
        fail('a nonempty assign array is required');
    }
    const nodes = [];
    const assigned = new Set();
    let next = 0;
    let intermediate = 0;
    const labels = options.labels || {};
    const sharedInputs = copy(options.sharedInputs || []);
    if (!Array.isArray(sharedInputs)) { fail('sharedInputs must be an array'); }
    const sharedNets = new Set(sharedInputs.map(input => input && input.net));
    if (options.boundaryPlacement !== undefined && !['ends', 'near'].includes(options.boundaryPlacement)) {
        fail('boundaryPlacement must be ends or near');
    }
    const nodeId = () => 'n' + next++;
    // Reserve source strings too: an external net can use our generated prefix.
    const reserved = new Set();
    const reserve = value => {
        if (typeof value === 'string') { reserved.add(value); } else if (Array.isArray(value)) { value.forEach(reserve); } else if (value && typeof value === 'object') { Object.values(value).forEach(reserve); }
    };
    reserve(source.assign);
    function temporary () {
        let name;
        do { name = '__wavedrom_' + intermediate++; } while (reserved.has(name));
        reserved.add(name);
        return name;
    }
    function gate (net, expression, label) {
        if (typeof expression === 'string') { expression = ['=', expression]; }
        if (!Array.isArray(expression) || expression.length < 2) { fail('invalid expression for ' + net); }
        let type = primitive(expression[0]);
        let args = expression.slice(1);
        if (['NOT', 'BUF'].includes(type) && args.length !== 1) { fail(type + ' requires one input'); }
        if (type === 'NOT' && Array.isArray(args[0])) {
            type = complements[primitive(args[0][0])];
            args = args[0].slice(1);
        }
        if (['NOT', 'BUF'].includes(type) && args.length !== 1) { fail(type + ' requires one input'); }
        const id = nodeId();
        const inputs = args.map((argument, index) => {
            if (typeof argument === 'string') { return port(id, 'I' + index, argument); }
            if (Array.isArray(argument) && argument.length === 2 && argument[0] === '~' && typeof argument[1] === 'string') {
                return port(id, 'I' + index, argument[1], true);
            }
            if (!Array.isArray(argument)) { fail('input must be a net string or gate expression'); }
            const wire = temporary();
            gate(wire, argument, '');
            return port(id, 'I' + index, wire);
        });
        nodes.push({id, type, ...(label ? {label} : {}), assignment: net, inputs, outputs: [port(id, 'Y', net, ['NAND', 'NOR', 'XNOR', 'NOT'].includes(type))]});
    }
    for (const row of source.assign) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[0]) {
            fail('each assignment must be [output net, expression or cell]');
        }
        const [net, expression] = row;
        if (assigned.has(net)) { fail('duplicate driver for ' + net); }
        assigned.add(net);
        if (expression && typeof expression === 'object' && !Array.isArray(expression)) {
            const cell = copy(expression);
            const aliases = {D_FF: 'DFF', LATCH: 'DLATCH', D_LATCH: 'DLATCH', SR_LATCH: 'SRLATCH'};
            cell.type = aliases[String(cell.type).toUpperCase()] || String(cell.type).toUpperCase();
            const cellLabel = cell.id || own(labels, net);
            if (cellLabel) { cell.id = cellLabel; }
            const id = nodeId();
            const inputs = Object.entries(cell.inputs || {}).map(([name, value]) => port(id, name, typeof value === 'string' ? value : value.net));
            const primary = cell.output || (['TIMER', 'COUNTER', 'ONESHOT'].includes(cell.type) ? 'OUT' : 'Q');
            const outputs = [port(id, primary, net, primary.endsWith('N'))];
            if (cell.complement) {
                const opposite = primary.endsWith('N') ? primary.slice(0, -1) : primary + 'N';
                outputs.push(port(id, opposite, cell.complement, opposite.endsWith('N')));
            }
            nodes.push({id, type: cell.type, ...(cellLabel ? {label: cellLabel} : {}), assignment: net, cell, inputs, outputs});
        } else {
            gate(net, expression, own(labels, net));
        }
    }
    const drivers = new Map();
    for (const node of nodes) {
        for (const output of node.outputs) {
            if (drivers.has(output.net)) { fail('duplicate driver for ' + output.net); }
            drivers.set(output.net, {node: node.id, port: output.id});
        }
    }
    const missing = [...new Set(nodes.flatMap(node => node.inputs.map(pin => pin.net)).filter(net => !drivers.has(net)))];
    for (const input of sharedInputs) {
        if (!input || !missing.includes(input.net)) { fail('shared input must name a used external net'); }
    }
    const inputLabels = options.inputLabels || {};
    for (const net of missing) {
        const id = nodeId();
        if (sharedNets.has(net)) { continue; }
        const output = port(id, 'Y', net);
        nodes.push({id, type: 'INPUT', label: own(inputLabels, net) || net, inputs: [], outputs: [output]});
        drivers.set(net, {node: id, port: output.id});
    }
    const consumed = new Set(nodes.flatMap(node => node.inputs.map(pin => pin.net)));
    const outputs = options.outputs || [...assigned].filter(net => !consumed.has(net)).map(net => ({net, label: net}));
    for (const value of outputs) {
        const output = typeof value === 'string' ? {net: value, label: value} : value;
        if (!drivers.has(output.net)) { fail('undefined output net ' + output.net); }
        const id = nodeId();
        nodes.push({id, type: 'OUTPUT', label: output.label || output.net, inputs: [port(id, 'A', output.net)], outputs: []});
    }
    if (options.layoutOrder !== undefined) {
        if (!Array.isArray(options.layoutOrder) || options.layoutOrder.some(key => typeof key !== 'string')) { fail('layoutOrder must be an array of strings'); }
        const order = new Map(options.layoutOrder.map((key, i) => [key, i]));
        const rank = node => order.get(node.assignment || node.label || node.id) ?? -1;
        nodes.sort((a, b) => rank(a) - rank(b));
    }
    for (const node of nodes) {
        const size = renderCircuit.measureNode(node);
        node.width = size.width;
        node.height = size.height;
        node.inputs = size.inputs.map(pin => ({...node.inputs.find(original => original.name === pin.name), x: pin.x, y: pin.y, ...(pin.inverted === undefined ? {} : {inverted: pin.inverted})}));
        node.outputs = size.outputs.map(pin => ({...node.outputs.find(original => original.name === pin.name), x: pin.x, y: pin.y, ...(pin.inverted === undefined ? {} : {inverted: pin.inverted})}));
    }
    const edges = [];
    for (const node of nodes) {
        for (const input of node.inputs) {
            if (sharedNets.has(input.net)) { continue; }
            const driver = drivers.get(input.net);
            if (!driver) { fail('no driver for ' + input.net); }
            edges.push({id: 'e' + edges.length, net: input.net, source: driver, target: {node: node.id, port: input.id}});
        }
    }
    const graph = {
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
            'elk.padding': '[top=' + (sharedInputs.length ? 44 + 16 * sharedInputs.length : 36) + ',left=24,bottom=24,right=24]',
            'elk.spacing.nodeNode': '48', 'elk.layered.spacing.nodeNodeBetweenLayers': '72',
            'elk.spacing.edgeNode': '18', 'elk.layered.spacing.edgeNodeBetweenLayers': '24',
            'elk.spacing.edgeEdge': '12', 'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
            'elk.layered.cycleBreaking.strategy': 'GREEDY',
            'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
            'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
            'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
            ...(options.layoutOptions || {})
        },
        children: nodes.map(node => ({
            id: node.id, width: node.width + (node.inputs.some(pin => sharedNets.has(pin.net)) ? 32 : 0), height: node.height,
            layoutOptions: {'elk.portConstraints': 'FIXED_POS',
                ...(node.type === 'INPUT' && options.boundaryPlacement !== 'near' ? {'elk.layered.layering.layerConstraint': 'FIRST'} : {}),
                ...(node.type === 'OUTPUT' && options.boundaryPlacement !== 'near' ? {'elk.layered.layering.layerConstraint': 'LAST'} : {})},
            ports: [...node.inputs.map(pin => ({...pin, side: 'WEST'})), ...node.outputs.map(pin => ({...pin, side: 'EAST'}))]
                .map(pin => ({id: pin.id, x: pin.x + (pin.side === 'EAST' && node.inputs.some(input => sharedNets.has(input.net)) ? 32 : 0), y: pin.y, width: 0, height: 0, layoutOptions: {'elk.port.side': pin.side}}))
        })),
        edges: edges.map(edge => ({id: edge.id, sources: [edge.source.port], targets: [edge.target.port]}))
    };
    const elk = new ELK();
    let laidOut;
    try { laidOut = await elk.layout(graph); } finally {
        // The bundled in-process worker has no terminate method; native workers do.
        if (elk.worker && elk.worker.worker && typeof elk.worker.worker.terminate === 'function') { elk.terminateWorker(); }
    }
    const byId = new Map(laidOut.children.map(node => [node.id, node]));
    for (const node of nodes) {
        node.x = byId.get(node.id).x + (node.inputs.some(pin => sharedNets.has(pin.net)) ? 32 : 0);
        node.y = byId.get(node.id).y;
    }
    const byEdge = new Map(laidOut.edges.map(edge => [edge.id, edge]));
    for (const edge of edges) {
        const route = byEdge.get(edge.id);
        if (!route.sections || route.sections.length !== 1) { fail('missing or ambiguous route for ' + edge.id); }
        const section = route.sections[0];
        edge.points = [section.startPoint, ...(section.bendPoints || []), section.endPoint].map(point => ({x: point.x, y: point.y}));
        const target = nodes.find(node => node.id === edge.target.node);
        if (target.inputs.some(pin => sharedNets.has(pin.net))) {
            const pin = target.inputs.find(input => input.id === edge.target.port);
            // ELK routes to the padded west face; continue across the reserved
            // utility-terminal gutter to the actual control pin.
            edge.points[edge.points.length - 1].x = target.x + pin.x;
        }
    }
    const result = {
        ...(source.title ? {title: source.title} : {}),
        circuit: {width: laidOut.width, height: laidOut.height, nodes, edges, junctions: junctions(edges), ...(sharedInputs.length ? {sharedInputs} : {})},
        _connectivity: {assignments: assigned.size, inputNets: missing.length, nodes: nodes.length, wires: edges.length, nets: drivers.size + sharedInputs.length,
            ...(sharedInputs.length ? {sharedConnections: nodes.reduce((total, node) => total + node.inputs.filter(pin => sharedNets.has(pin.net)).length, 0)} : {})}
    };
    // The renderer validates endpoints against the original, fixed pin geometry.
    renderCircuit(0, result);
    return result;
}

module.exports = compileCircuit;
