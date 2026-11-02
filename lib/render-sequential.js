'use strict';

const textWidth = require('./text-width.js');

const aliases = {LATCH: 'DLATCH', D_LATCH: 'DLATCH', SR_LATCH: 'SRLATCH', D_FF: 'DFF'};
const definitions = {
    DFF: {required: ['D', 'CLK'], optional: ['RESET', 'SET'], storage: true},
    DLATCH: {required: ['D', 'EN'], optional: ['RESET', 'SET'], storage: true},
    SRLATCH: {required: ['S', 'R'], optional: ['RESET', 'SET'], storage: true},
    TIMER: {required: ['IN'], optional: ['CLK', 'RESET', 'EN']},
    COUNTER: {required: ['CLK'], optional: ['RESET', 'EN', 'LOAD']},
    ONESHOT: {required: ['IN'], optional: ['CLK', 'RESET', 'EN']}
};
const allowed = ['type', 'id', 'inputs', 'edge', 'output', 'complement', 'initial', 'mode', 'delay', 'count', 'divider'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error('Sequential symbol: ' + message); };
const own = (object, name) => Object.prototype.hasOwnProperty.call(object, name);
// onml.stringify writes raw text; escape author-provided labels at the boundary.
const escapeText = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function label (value, name) {
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
        fail(name + ' must be a nonempty, single-line string');
    }
    return value;
}

function knownFields (object, names, context) {
    for (const key of Object.keys(object)) {
        if (!names.includes(key)) {
            fail('unknown ' + context + ' field ' + key);
        }
    }
}

function input (value, name) {
    if (typeof value === 'string') {
        return {net: label(value, name), active: 'high'};
    }
    if (!isObject(value)) {
        fail(name + ' must be a net string or {net, active}');
    }
    knownFields(value, ['net', 'active'], 'input');
    const active = value.active === undefined ? 'high' : value.active;
    if (!['high', 'low'].includes(active)) {
        fail(name + '.active must be high or low');
    }
    return {net: label(value.net, name + '.net'), active};
}

// Validation is deliberately explicit: symbol polarity must not be inferred.
// eslint-disable-next-line complexity
function normalize (output, cell) {
    label(output, 'assigned output');
    if (!isObject(cell)) { fail('cell must be an object'); }
    knownFields(cell, allowed, 'cell');
    const rawType = label(cell.type, 'type').toUpperCase();
    const type = aliases[rawType] || rawType;
    const def = own(definitions, type) ? definitions[type] : undefined;
    if (!def) { fail('unsupported type ' + rawType); }
    if (!isObject(cell.inputs)) { fail(type + '.inputs must be an object'); }
    const portNames = [...def.required, ...def.optional];
    knownFields(cell.inputs, portNames, type + ' port');
    for (const name of def.required) {
        if (!own(cell.inputs, name)) { fail(type + ' requires input ' + name); }
    }
    const inputs = portNames.filter(name => own(cell.inputs, name)).map(name => ({name, ...input(cell.inputs[name], name)}));
    const edge = cell.edge === undefined ? 'rising' : cell.edge;
    if (!['rising', 'falling'].includes(edge)) { fail('edge must be rising or falling'); }
    if (cell.edge !== undefined && !['DFF', 'COUNTER', 'ONESHOT'].includes(type)) {
        fail('edge applies to DFF, COUNTER or ONESHOT; use TIMER mode for delays');
    }
    // Edge polarity is expressed once. A LOW-active clock plus a falling-edge
    // option would otherwise ambiguously invert the edge a second time.
    for (const pin of inputs) {
        if ((pin.name === 'CLK' || (type === 'ONESHOT' && pin.name === 'IN')) && pin.active === 'low') {
            fail(pin.name + ' polarity uses edge, not active:low');
        }
    }
    if (cell.mode !== undefined && (type !== 'TIMER' || !['on-delay', 'off-delay'].includes(cell.mode))) {
        fail('mode must be TIMER on-delay or off-delay');
    }
    for (const key of ['delay', 'count', 'divider']) {
        if (cell[key] !== undefined && def.storage) { fail(key + ' is a timer/counter annotation'); }
    }
    if (cell.delay !== undefined) { label(cell.delay, 'delay'); }
    if (cell.count !== undefined && (!Number.isSafeInteger(cell.count) || cell.count < 0)) {
        fail('count must be a nonnegative safe integer');
    }
    if (cell.divider !== undefined && (!Number.isSafeInteger(cell.divider) || cell.divider < 1)) {
        fail('divider must be a positive safe integer');
    }
    if (cell.initial !== undefined && ![0, 1].includes(cell.initial)) { fail('initial must be 0 or 1'); }
    const primary = cell.output === undefined ? (def.storage ? 'Q' : 'OUT') : cell.output;
    const permittedOutputs = def.storage ? ['Q', 'QN'] : ['OUT', 'OUTN'];
    if (!permittedOutputs.includes(primary)) { fail('output must be ' + permittedOutputs.join(' or ')); }
    const outputs = [{name: primary, net: output, inverted: primary.endsWith('N')}];
    if (cell.complement !== undefined) {
        label(cell.complement, 'complement');
        if (cell.complement === output) { fail('complement must name a different net'); }
        const opposite = permittedOutputs.find(name => name !== primary);
        outputs.push({name: opposite, net: cell.complement, inverted: opposite.endsWith('N')});
    }
    if (cell.id !== undefined) { label(cell.id, 'id'); }
    return {...cell, type, edge, inputs, outputs};
}

function text (x, y, value, attributes = {}) {
    return ['text', {x, y, 'font-family': 'Arial,Helvetica,sans-serif', 'font-size': 13, fill: '#182b3a', stroke: 'none', ...attributes}, escapeText(value)];
}

function line (x1, y1, x2, y2) {
    return ['path', {d: 'M' + x1 + ',' + y1 + 'H' + x2 + (y1 === y2 ? '' : 'V' + y2), fill: 'none', stroke: '#182b3a', 'stroke-width': 1.5}];
}

function inversion (x, y) {
    return ['circle', {'data-role': 'inversion', cx: x, cy: y, r: 4, fill: 'white', stroke: '#182b3a', 'stroke-width': 1.5}];
}

function triangle (x, y) {
    return ['path', {'data-role': 'clock-edge', d: 'M' + x + ',' + (y - 6) + 'l9,6 -9,6', fill: 'none', stroke: '#182b3a', 'stroke-width': 1.5}];
}

function annotationLines (cell) {
    const lines = [];
    if (cell.mode !== undefined) { lines.push(cell.mode); }
    if (cell.delay !== undefined) { lines.push('t = ' + cell.delay); }
    if (cell.count !== undefined || cell.divider !== undefined) {
        lines.push([
            ...(cell.count === undefined ? [] : ['N = ' + cell.count]),
            ...(cell.divider === undefined ? [] : ['DIV = ' + cell.divider])
        ].join('   '));
    }
    if (cell.initial !== undefined) { lines.push('initial output = ' + cell.initial); }
    return lines;
}

function drawInput (cell, pin, x, y) {
    const clock = (['DFF', 'COUNTER'].includes(cell.type) && pin.name === 'CLK') || (cell.type === 'ONESHOT' && pin.name === 'IN');
    const inverted = clock ? cell.edge === 'falling' : pin.active === 'low';
    const async = definitions[cell.type].storage && ['RESET', 'SET'].includes(pin.name);
    const pinText = {RESET: 'R', SET: 'S'}[pin.name] || pin.name;
    return ['g', {'data-port': pin.name, ...(async ? {'data-asynchronous': 'true'} : {})},
        line(x - 34, y, x - (inverted ? 8 : 0), y),
        ...(inverted ? [inversion(x - 4, y)] : []),
        ...(clock ? [triangle(x, y)] : []),
        text(x - 42, y + 4, pin.net, {'text-anchor': 'end'}),
        text(x + (clock ? 16 : 10), y + 4, pinText),
        ...(async ? [text(x + 28, y + 4, 'async', {'font-size': 10, fill: '#566c7c'})] : [])
    ];
}

function drawOutput (pin, x, y) {
    const baseName = pin.name.startsWith('Q') ? 'Q' : 'OUT';
    return ['g', {'data-role': 'output', 'data-port': pin.name},
        line(x + (pin.inverted ? 8 : 0), y, x + 34, y),
        ...(pin.inverted ? [inversion(x + 4, y)] : []),
        text(x - 10, y + 4, baseName, {'text-anchor': 'end', ...(pin.inverted ? {'text-decoration': 'overline'} : {})}),
        text(x + 42, y + 4, pin.net)
    ];
}

// Returns a self-contained ONML group and measured extents. Coordinates reserve
// room for labels; inline styles keep symbols independent of timing skins.
function renderCell (output, source) {
    const cell = normalize(output, source);
    const annotations = annotationLines(cell);
    const bodyWidth = Math.max(150, ...annotations.map(value => textWidth(value, 13) + 30));
    const left = Math.max(24, ...cell.inputs.map(pin => textWidth(pin.net, 13))) + 48;
    const right = Math.max(24, ...cell.outputs.map(pin => textWidth(pin.net, 13))) + 48;
    const top = 30;
    const rows = Math.max(cell.inputs.length, cell.outputs.length);
    const height = 48 + rows * 28;
    const width = Math.max(left + bodyWidth + right, cell.id ? left + textWidth(cell.id, 14) + 24 : 0);
    const totalHeight = top + height + annotations.length * 19 + 16;
    const svg = ['g', {'data-symbol': cell.type},
        ['title', {}, escapeText(cell.type + (cell.id ? ' ' + cell.id : '') + ' (graphical symbol; no simulation)')],
        ...(cell.id ? [text(left, 18, cell.id, {'font-size': 14, 'font-weight': 'bold'})] : []),
        ['rect', {'data-role': 'body', x: left, y: top, width: bodyWidth, height, fill: 'white', stroke: '#182b3a', 'stroke-width': 1.5}],
        text(left + bodyWidth / 2, top + 21, cell.type, {'text-anchor': 'middle', 'font-size': 12, 'font-weight': 'bold'}),
        ...cell.inputs.map((pin, index) => drawInput(cell, pin, left, top + 48 + index * 28)),
        ...cell.outputs.map((pin, index) => drawOutput(pin, left + bodyWidth, top + 48 + index * 28)),
        ...annotations.map((value, index) => text(left + bodyWidth / 2, top + height + 17 + index * 19, value, {'text-anchor': 'middle', 'font-size': 12, fill: '#566c7c'}))
    ];
    return {width, height: totalHeight, svg};
}

module.exports = renderCell;
