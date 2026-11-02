/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const {parse, stringify} = require('onml');
const renderAny = require('../lib/render-any.js');
const renderCell = require('../lib/render-sequential.js');
const legacyRenderAssign = require('logidrom/lib/render-assign.js');
const waveSkin = require('../skins/default.js');
const w3 = require('../lib/w3.js');

const clone = value => JSON.parse(JSON.stringify(value));
const attrs = node => (node[1] && !Array.isArray(node[1]) && typeof node[1] === 'object') ? node[1] : {};

function nodes (tree, predicate) {
    const found = [];
    function visit (node) {
        if (!Array.isArray(node)) return;
        if (typeof node[0] === 'string' && predicate(node, attrs(node))) found.push(node);
        for (const child of node) {
            if (Array.isArray(child)) visit(child);
        }
    }
    visit(tree);
    return found;
}

const by = (tree, attribute, value) => nodes(tree, (node, attributes) => attributes[attribute] === value);
const text = tree => nodes(tree, node => node[0] === 'text').map(node => node.slice(2).join('')).join(' ');

function freeze (value) {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        Object.values(value).forEach(freeze);
    }
    return value;
}

function cell (type, extra = {}) {
    const inputs = {
        DFF: {D: 'data', CLK: 'clk'},
        DLATCH: {D: 'data', EN: 'enable'},
        SRLATCH: {S: 'set', R: 'reset'},
        TIMER: {IN: 'enable'},
        COUNTER: {CLK: 'clk'},
        ONESHOT: {IN: 'trigger'}
    };
    return {type, id: 'U1', inputs: inputs[type], ...extra};
}

function render (definition, output = 'result') {
    return renderAny(0, {assign: [[output, definition]]}, waveSkin);
}

function port (tree, name) {
    const matches = by(tree, 'data-port', name);
    assert.equal(matches.length, 1, 'Expected exactly one ' + name + ' port');
    assert.equal(matches[0][0], 'g');
    return matches[0];
}

function inversionCount (tree) {
    const bubbles = by(tree, 'data-role', 'inversion');
    bubbles.forEach(node => {
        assert.equal(node[0], 'circle');
        assert.ok(Number(attrs(node).r) > 0);
    });
    return bubbles.length;
}

function dimensions (svg) {
    assert.equal(svg[0], 'svg');
    const viewBox = String(attrs(svg).viewBox).split(/[ ,]+/).map(Number);
    assert.equal(viewBox.length, 4);
    assert.ok(viewBox.every(Number.isFinite));
    assert.ok(viewBox[2] > 0 && viewBox[3] > 0);
    return viewBox;
}

describe('sequential assignment symbols', function () {
    for (const type of ['DFF', 'DLATCH', 'SRLATCH', 'TIMER', 'COUNTER', 'ONESHOT']) {
        it('renders ' + type + ' through the public renderer with a rectangular body', function () {
            const result = render(cell(type));
            dimensions(result);
            const symbols = by(result, 'data-symbol', type);
            assert.equal(symbols.length, 1);
            assert.equal(symbols[0][0], 'g');
            const bodies = by(symbols[0], 'data-role', 'body');
            assert.equal(bodies.length, 1);
            assert.equal(bodies[0][0], 'rect');
            assert.ok(Number(attrs(bodies[0]).width) > 0);
            assert.ok(Number(attrs(bodies[0]).height) > 0);
            const outputs = by(symbols[0], 'data-role', 'output');
            assert.equal(outputs.length, 1);
            assert.equal(attrs(outputs[0])['data-port'], /LATCH|DFF/.test(type) ? 'Q' : 'OUT');
        });
    }

    for (const [alias, canonical] of [['LATCH', 'DLATCH'], ['D_LATCH', 'DLATCH'], ['SR_LATCH', 'SRLATCH'], ['D_FF', 'DFF']]) {
        it('normalizes the ' + alias + ' alias', function () {
            assert.equal(by(render(cell(canonical, {type: alias})), 'data-symbol', canonical).length, 1);
        });
    }

    it('returns independently measurable cell geometry', function () {
        const result = renderCell('q', cell('DFF'));
        assert.ok(Number.isFinite(result.width) && result.width > 0);
        assert.ok(Number.isFinite(result.height) && result.height > 0);
        assert.equal(by(result.svg, 'data-symbol', 'DFF').length, 1);
    });

    it('marks a rising DFF clock with a triangle and no inversion bubble', function () {
        const clk = port(render(cell('DFF')), 'CLK');
        const triangles = by(clk, 'data-role', 'clock-edge');
        assert.equal(triangles.length, 1);
        assert.equal(triangles[0][0], 'path');
        assert.ok(String(attrs(triangles[0]).d).length > 0);
        assert.equal(inversionCount(clk), 0);
    });

    for (const [type, name] of [['DFF', 'CLK'], ['COUNTER', 'CLK'], ['ONESHOT', 'IN']]) {
        it('draws a falling ' + type + ' edge as a triangle and inversion bubble', function () {
            const input = port(render(cell(type, {edge: 'falling'})), name);
            assert.equal(by(input, 'data-role', 'clock-edge').length, 1);
            assert.equal(inversionCount(input), 1);
        });
    }

    it('draws a latch enable as a level input without a clock triangle', function () {
        const result = render(cell('DLATCH', {inputs: {D: 'data', EN: {net: 'enable_n', active: 'low'}}}));
        assert.equal(by(result, 'data-role', 'clock-edge').length, 0);
        assert.equal(inversionCount(port(result, 'EN')), 1);
        assert.equal(inversionCount(port(result, 'D')), 0);
    });

    it('shows independent active-low set/reset ports', function () {
        const result = render(cell('DFF', {inputs: {
            D: 'data', CLK: 'clk',
            RESET: {net: 'reset_n', active: 'low'},
            SET: {net: 'set_n', active: 'low'}
        }}));
        assert.equal(inversionCount(port(result, 'RESET')), 1);
        assert.equal(inversionCount(port(result, 'SET')), 1);
        assert.equal(inversionCount(port(result, 'CLK')), 0);
    });

    it('shows both active-low SR latch inputs without clock triangles', function () {
        const result = render(cell('SRLATCH', {inputs: {
            S: {net: 'set_n', active: 'low'},
            R: {net: 'reset_n', active: 'low'}
        }}));
        assert.equal(inversionCount(port(result, 'S')), 1);
        assert.equal(inversionCount(port(result, 'R')), 1);
        assert.equal(by(result, 'data-role', 'clock-edge').length, 0);
    });

    for (const [type, normal, inverted] of [['DFF', 'Q', 'QN'], ['TIMER', 'OUT', 'OUTN']]) {
        it('assigns complementary ' + type + ' outputs their actual polarities', function () {
            for (const selected of [normal, inverted]) {
                const result = render(cell(type, {output: selected, complement: 'other_net'}), 'primary_net');
                assert.equal(by(result, 'data-role', 'output').length, 2);
                assert.equal(inversionCount(port(result, normal)), 0);
                assert.equal(inversionCount(port(result, inverted)), 1);
                const opposite = selected === normal ? inverted : normal;
                assert.ok(text(port(result, selected)).includes('primary_net'));
                assert.ok(!text(port(result, selected)).includes('other_net'));
                assert.ok(text(port(result, opposite)).includes('other_net'));
                assert.ok(!text(port(result, opposite)).includes('primary_net'));
            }
        });
    }

    it('renders a sole inverted output without adding an unconnected normal output', function () {
        const result = render(cell('DFF', {output: 'QN'}));
        assert.equal(by(result, 'data-role', 'output').length, 1);
        assert.equal(by(result, 'data-port', 'Q').length, 0);
        assert.equal(inversionCount(port(result, 'QN')), 1);
    });

    it('shows timer parameters and distinguishes explicit timer modes', function () {
        const on = text(parse(stringify(render(cell('TIMER', {mode: 'on-delay', delay: '10 ms'})))));
        const off = text(parse(stringify(render(cell('TIMER', {mode: 'off-delay', delay: '10 ms'})))));
        assert.ok(on.includes('10 ms'));
        assert.ok(off.includes('10 ms'));
        assert.notEqual(on, off);
        assert.equal(by(render(cell('TIMER')), 'data-role', 'clock-edge').length, 0);
    });

    it('does not turn optional timer or one-shot reference clocks into trigger inputs', function () {
        const timer = render(cell('TIMER', {inputs: {IN: 'enable', CLK: 'reference_clk', RESET: 'reset'}}));
        assert.equal(by(timer, 'data-role', 'clock-edge').length, 0);
        assert.equal(by(port(timer, 'RESET'), 'data-asynchronous', 'true').length, 0);
        const pulse = render(cell('ONESHOT', {edge: 'falling', inputs: {IN: 'trigger', CLK: 'reference_clk'}}));
        assert.equal(by(port(pulse, 'IN'), 'data-role', 'clock-edge').length, 1);
        assert.equal(by(port(pulse, 'CLK'), 'data-role', 'clock-edge').length, 0);
        assert.equal(inversionCount(port(pulse, 'CLK')), 0);
    });

    it('accepts zero count and valid divider/initial metadata', function () {
        const result = render(cell('COUNTER', {count: 0, divider: 1, initial: 0,
            inputs: {CLK: 'clk', RESET: 'reset', EN: 'enable', LOAD: 'load'}}));
        dimensions(result);
        ['CLK', 'RESET', 'EN', 'LOAD'].forEach(name => port(result, name));
        assert.ok(text(parse(stringify(result))).includes('0'));
    });

    it('keeps legacy assignment output identical to upstream', function () {
        const source = {assign: [['and_result', ['&', 'a', 'b']], ['inverted', ['~', 'and_result']]]};
        const expected = legacyRenderAssign(7, clone(source));
        expected[1].xmlns = w3.svg;
        expected[1]['xmlns:xlink'] = w3.xlink;
        expected[1].class = 'WaveDrom';
        assert.deepEqual(renderAny(7, clone(source), waveSkin), expected);
    });

    it('provides shared classic styles when the first assignment diagram contains only cells', function () {
        const classic = {assign: [['capture', ['&', 'a', 'b']]]};
        const first = renderAny(0, {assign: [['q', cell('DFF')]]}, waveSkin, false, false);
        const expectedStyles = nodes(legacyRenderAssign(0, clone(classic), false), node => node[0] === 'style');
        assert.ok(expectedStyles.length > 0);
        assert.deepEqual(nodes(first, node => node[0] === 'style'), expectedStyles);
        // processAll sets notFirstAssign after any assign diagram. A later
        // classic diagram relies on the stylesheet supplied by the first one.
        const second = renderAny(1, clone(classic), waveSkin, false, true);
        assert.equal(nodes(second, node => node[0] === 'style').length, 0);
        assert.ok(nodes(second, (node, attributes) => {
            const classes = Array.isArray(attributes.class) ? attributes.class : String(attributes.class || '').split(' ');
            return classes.includes('wire');
        }).length > 0);
    });

    it('preserves attributed classic rows in mixed diagrams without mutating their attributes', function () {
        const classicRow = ['capture', {dir: 'out'}, ['&', 'a', 'b']];
        const source = {assign: [classicRow, ['captured', cell('DFF', {inputs: {D: 'capture', CLK: 'clk'}})]]};
        const before = clone(source);
        const result = renderAny(0, freeze(source), waveSkin);
        dimensions(result);
        assert.deepEqual(source, before);
        const classicPanels = nodes(result, node => node[0] === 'svg').filter(node => node !== result);
        assert.equal(classicPanels.length, 1);
        const expected = legacyRenderAssign('reference', {assign: [clone(classicRow)]}, true);
        expected[1].id = attrs(classicPanels[0]).id;
        assert.deepEqual(classicPanels[0], expected);
        assert.equal(by(result, 'data-symbol', 'DFF').length, 1);
    });

    it('mixes legacy gates and sequential objects without mutating the source', function () {
        const source = {title: 'Capture', config: {assignColumns: 2}, assign: [
            ['capture', ['&', 'enable', 'valid']],
            ['captured', cell('DFF', {inputs: {D: 'capture', CLK: 'clk'}})]
        ]};
        const before = clone(source);
        const result = renderAny(0, freeze(source), waveSkin);
        dimensions(result);
        assert.deepEqual(source, before);
        assert.equal(by(result, 'data-symbol', 'DFF').length, 1);
        assert.ok(text(parse(stringify(result))).includes('capture'));
    });

    it('does not mutate a directly rendered cell', function () {
        const definition = cell('DFF', {complement: 'q_n', inputs: {D: 'data', CLK: 'clk', RESET: {net: 'reset_n', active: 'low'}}});
        const before = clone(definition);
        renderCell('q', freeze(definition));
        assert.deepEqual(definition, before);
    });

    for (const columns of [1, 2, 3, 4]) {
        it('renders every assignment with ' + columns + ' configured columns', function () {
            const source = {config: {assignColumns: columns}, assign: ['DFF', 'DLATCH', 'SRLATCH', 'TIMER', 'COUNTER', 'ONESHOT'].map((type, index) => ['out' + index, cell(type)])};
            const result = renderAny(0, source, waveSkin);
            dimensions(result);
            assert.equal(nodes(result, (node, attributes) => Boolean(attributes['data-symbol'])).length, 6);
        });
    }

    it('expands the viewBox for long input/output labels', function () {
        const short = dimensions(render(cell('DFF')));
        const long = dimensions(render(cell('DFF', {inputs: {D: 'very_long_input_signal_'.repeat(6), CLK: 'clk'}}), 'very_long_output_signal_'.repeat(6)));
        assert.ok(long[2] > short[2]);
    });

    it('keeps a long instance ID inside its measured width when the left labels grow', function () {
        const id = 'W'.repeat(180);
        const short = renderCell('q', cell('DFF', {id}));
        const long = renderCell('q', cell('DFF', {id, inputs: {D: 'long_input_'.repeat(8), CLK: 'clk'}}));
        const idX = result => Number(attrs(nodes(result.svg, node => node[0] === 'text' && node[2] === id)[0]).x);
        const movedRight = idX(long) - idX(short);
        assert.ok(movedRight > 0);
        assert.ok(long.width - short.width + 1e-6 >= movedRight);
    });

    it('escapes XML metacharacters in user labels, IDs, metadata and title', function () {
        const special = '<script>&"\' payload';
        const source = {title: special, assign: [[special, cell('TIMER', {
            id: special, delay: special, inputs: {IN: special}, complement: special + '_n'
        })]]};
        const xml = stringify(renderAny(0, source, waveSkin));
        assert.ok(xml.includes('&lt;script&gt;'));
        assert.ok(xml.includes('&amp;'));
        const parsed = parse(xml);
        assert.equal(nodes(parsed, node => node[0] === 'script').length, 0);
        assert.ok(text(parsed).includes(special));
    });

    const invalid = [
        ['unknown symbol type', {type: 'FLIPFLOP', inputs: {D: 'd', CLK: 'clk'}}],
        ['missing DFF data', cell('DFF', {inputs: {CLK: 'clk'}})],
        ['missing DFF clock', cell('DFF', {inputs: {D: 'd'}})],
        ['missing latch enable', cell('DLATCH', {inputs: {D: 'd'}})],
        ['missing SR reset', cell('SRLATCH', {inputs: {S: 'set'}})],
        ['missing timer input', cell('TIMER', {inputs: {}})],
        ['missing counter clock', cell('COUNTER', {inputs: {}})],
        ['missing one-shot input', cell('ONESHOT', {inputs: {}})],
        ['unknown field', cell('DFF', {mystery: 1})],
        ['unknown input port', cell('DFF', {inputs: {D: 'd', CLK: 'clk', BAD: 'bad'}})],
        ['unknown input object field', cell('DFF', {inputs: {D: {net: 'd', polarity: 'low'}, CLK: 'clk'}})],
        ['empty input label', cell('DFF', {inputs: {D: '', CLK: 'clk'}})],
        ['multiline input label', cell('DFF', {inputs: {D: 'data\nnext', CLK: 'clk'}})],
        ['duplicate complementary net', cell('DFF', {complement: 'result'})],
        ['negative count', cell('COUNTER', {count: -1})],
        ['fractional count', cell('COUNTER', {count: 1.5})],
        ['zero divider', cell('COUNTER', {divider: 0})],
        ['invalid initial value', cell('DFF', {initial: 2})],
        ['storage timer annotations', cell('DFF', {delay: '1 ms'})],
        ['invalid timer mode', cell('TIMER', {mode: 'retrigger'})],
        ['invalid edge', cell('DFF', {edge: 'both'})],
        ['edge configuration on a level latch', cell('DLATCH', {edge: 'falling'})],
        ['active-low clock', cell('DFF', {inputs: {D: 'd', CLK: {net: 'clk_n', active: 'low'}}})],
        ['active-low counter clock', cell('COUNTER', {inputs: {CLK: {net: 'clk_n', active: 'low'}}})],
        ['active-low one-shot trigger', cell('ONESHOT', {inputs: {IN: {net: 'trigger_n', active: 'low'}}})],
        ['invalid output name', cell('DFF', {output: 'OUT'})],
        ['invalid input polarity', cell('DFF', {inputs: {D: {net: 'd', active: 'sometimes'}, CLK: 'clk'}})]
    ];
    for (const [description, definition] of invalid) {
        it('rejects ' + description, function () {
            assert.throws(() => render(definition));
        });
    }

    for (const columns of [0, 5, 1.5]) {
        it('rejects unsupported column count ' + columns, function () {
            assert.throws(() => renderAny(0, {config: {assignColumns: columns}, assign: [['q', cell('DFF')]]}, waveSkin));
        });
    }
});
