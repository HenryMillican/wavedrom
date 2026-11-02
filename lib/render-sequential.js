'use strict';

const {getLabelWidth, CHAR_WIDTH_PX} = require('logidrom/lib/font-metrics.js');

// Use the existing logic renderer's intrinsic scale, not an SVG-wide shrink.
const FONT_SIZE = 12;
const PIN_PITCH = 16;
const PIN_LEAD = 16;
const BODY_WIDTH = 80;
const textWidth = (value, size = FONT_SIZE) => Math.ceil(String(value).length * CHAR_WIDTH_PX * size / FONT_SIZE);
const netWidth = (value, output = false) => Math.max(output ? 32 : 0, getLabelWidth(value) + 8);

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
    const attrs = {x, y, 'font-family': 'monospace', 'font-size': FONT_SIZE, 'font-weight': 500, fill: '#000', stroke: 'none', ...attributes};
    // Timing skins contain global text rules. Presentation attributes alone
    // lose to those rules when a timing plot shares the page with these cells.
    attrs.style = ['font-family', 'font-size', 'fill', 'stroke', 'font-weight', 'text-anchor', 'text-decoration']
        .filter(key => attrs[key] !== undefined)
        .map(key => key + ':' + attrs[key] + (key === 'font-size' ? 'px' : ''))
        .join(';');
    return ['text', attrs, escapeText(value)];
}

function line (x1, y1, x2, y2) {
    return ['path', {d: 'M' + x1 + ',' + y1 + 'H' + x2 + (y1 === y2 ? '' : 'V' + y2), fill: 'none', stroke: '#000', 'stroke-width': 1}];
}

function inversion (x, y) {
    return ['circle', {'data-role': 'inversion', cx: x, cy: y, r: 3, fill: '#aaa', stroke: '#000', 'stroke-width': 1}];
}

function triangle (x, y) {
    return ['path', {'data-role': 'clock-edge', d: 'M' + x + ',' + (y - 4) + 'l6,4 -6,4', fill: 'none', stroke: '#000', 'stroke-width': 1}];
}

function netLabel (value, x, y, output) {
    const width = netWidth(value, output);
    const left = output ? x : x - width;
    return ['g', {'data-role': 'net-label'},
        ['rect', {x: left, y: y - 8, width, height: 16, fill: '#eee', stroke: '#ccc', 'stroke-width': 1}],
        text(left + 4, y + 4, value)
    ];
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

function drawInput (cell, pin, x, y, connected = false) {
    const clock = (['DFF', 'COUNTER'].includes(cell.type) && pin.name === 'CLK') || (cell.type === 'ONESHOT' && pin.name === 'IN');
    const inverted = clock ? cell.edge === 'falling' : pin.active === 'low';
    const async = definitions[cell.type].storage && ['RESET', 'SET'].includes(pin.name);
    const pinText = {RESET: 'R', SET: 'S'}[pin.name] || pin.name;
    return ['g', {'data-port': pin.name, ...(async ? {'data-asynchronous': 'true'} : {})},
        line(x - PIN_LEAD, y, x - (inverted ? 6 : 0), y),
        ...(inverted ? [inversion(x - 3, y)] : []),
        ...(clock ? [triangle(x, y)] : []),
        ...(!connected ? [netLabel(pin.net, x - PIN_LEAD, y, false)] : []),
        text(x + (clock ? 10 : 4), y + 4, pinText),
        ...(async ? [text(x + 16, y + 4, 'async', {'font-size': 9})] : [])
    ];
}

function drawOutput (pin, x, y, connected = false) {
    const baseName = pin.name.startsWith('Q') ? 'Q' : 'OUT';
    return ['g', {'data-role': 'output', 'data-port': pin.name},
        line(x + (pin.inverted ? 6 : 0), y, x + PIN_LEAD, y),
        ...(pin.inverted ? [inversion(x + 3, y)] : []),
        text(x - 4, y + 4, baseName, {'text-anchor': 'end', ...(pin.inverted ? {'text-decoration': 'overline'} : {})}),
        ...(!connected ? [netLabel(pin.net, x + PIN_LEAD, y, true)] : [])
    ];
}

// Returns a self-contained ONML group and measured extents. Coordinates reserve
// room for labels; inline styles keep symbols independent of timing skins.
function renderCell (output, source, options = {}) {
    const cell = normalize(output, source);
    const connected = options.connected === true;
    const annotations = connected ? [
        ...(cell.mode === undefined ? [] : [cell.mode]),
        ...(cell.delay === undefined ? [] : ['t = ' + cell.delay]),
        ...(cell.initial === undefined ? [] : ['initial = ' + cell.initial])
    ] : annotationLines(cell);
    const annotationPitch = connected ? 12 : PIN_PITCH;
    const bodyWidth = BODY_WIDTH;
    const annotationWidth = Math.max(0, ...annotations.map(value => textWidth(value)));
    const left = connected ? PIN_LEAD : Math.max(...cell.inputs.map(pin => netWidth(pin.net) + PIN_LEAD), annotationWidth / 2 - bodyWidth / 2 + 4);
    const right = connected ? PIN_LEAD : Math.max(...cell.outputs.map(pin => netWidth(pin.net, true) + PIN_LEAD));
    const top = 20;
    const rows = Math.max(cell.inputs.length, cell.outputs.length);
    const height = PIN_PITCH * (rows + 1);
    const width = connected ? PIN_LEAD * 2 + bodyWidth : Math.max(left + bodyWidth + right, left + bodyWidth / 2 + annotationWidth / 2 + 4, cell.id ? left + textWidth(cell.id) + 4 : 0);
    const totalHeight = top + height + annotations.length * annotationPitch + 8;
    const svg = ['g', {'data-symbol': cell.type},
        ['title', {}, escapeText(connected ? JSON.stringify(source) : cell.type + (cell.id ? ' ' + cell.id : '') + ' (graphical symbol; no simulation)')],
        ...(cell.id ? [text(left, 12, cell.id)] : []),
        ['rect', {'data-role': 'body', class: 'gate', x: left, y: top, width: bodyWidth, height, fill: '#aaa', stroke: '#000', 'stroke-width': 1}],
        text(left + bodyWidth / 2, top + 12, cell.type, {'text-anchor': 'middle'}),
        ...cell.inputs.map((pin, index) => drawInput(cell, pin, left, top + 24 + index * PIN_PITCH, connected)),
        ...cell.outputs.map((pin, index) => drawOutput(pin, left + bodyWidth, top + 24 + index * PIN_PITCH, connected)),
        ...annotations.map((value, index) => text(left + bodyWidth / 2, top + height + 12 + index * annotationPitch, value, {'text-anchor': 'middle', ...(connected ? {'font-size': 9} : {})}))
    ];
    const inputs = cell.inputs.map((pin, index) => ({...pin, id: pin.name, x: left - PIN_LEAD, y: top + 24 + index * PIN_PITCH,
        inverted: ((['DFF', 'COUNTER'].includes(cell.type) && pin.name === 'CLK') || (cell.type === 'ONESHOT' && pin.name === 'IN')) ? cell.edge === 'falling' : pin.active === 'low'}));
    const outputs = cell.outputs.map((pin, index) => ({...pin, id: pin.name, x: left + bodyWidth + PIN_LEAD, y: top + 24 + index * PIN_PITCH}));
    return {width, height: totalHeight, svg, body: {x: left, y: top, width: bodyWidth, height}, inputs, outputs, ports: {inputs, outputs}};
}

module.exports = renderCell;
