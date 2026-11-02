'use strict';

const renderLegacy = require('logidrom/lib/render-assign.js');
const assignStyles = require('logidrom/lib/insert-svg-template-assign.js');
const renderCell = require('./render-sequential.js');
const textWidth = require('./text-width.js');
const escapeText = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function isCell (row) {
    const cell = Array.isArray(row) ? row[1] : undefined;
    return cell !== null && typeof cell === 'object' && !Array.isArray(cell) &&
        (Object.prototype.hasOwnProperty.call(cell, 'type') || Object.prototype.hasOwnProperty.call(cell, 'inputs'));
}

function legacyPanel (index, source, row) {
    // logidrom transforms its input during layout. The mixed form preserves the
    // caller's source so editors can safely render the same object repeatedly.
    const svg = renderLegacy(index, {assign: JSON.parse(JSON.stringify([row])), config: source.config}, true);
    return {width: svg[1].width, height: svg[1].height, svg};
}

function renderAssign (index, source, notFirstAssign) {
    if (!Array.isArray(source.assign) || !source.assign.some(isCell)) {
        return renderLegacy(index, source, notFirstAssign);
    }
    const config = source.config || {};
    const columns = config.assignColumns === undefined ? 1 : config.assignColumns;
    if (!Number.isInteger(columns) || columns < 1 || columns > 4) {
        throw new Error('Sequential symbol: config.assignColumns must be an integer from 1 to 4');
    }
    if (source.title !== undefined && (typeof source.title !== 'string' || /[\r\n]/.test(source.title))) {
        throw new Error('Sequential symbol: title must be a single-line string');
    }
    const panels = source.assign.map((row, position) => {
        if (!Array.isArray(row) || (isCell(row) && row.length !== 2)) {
            throw new Error('Sequential symbol: each cell assignment must be [output, cell]');
        }
        return isCell(row) ? renderCell(row[0], row[1]) : legacyPanel(index + '_' + position, source, row);
    });
    const usedColumns = Math.min(columns, panels.length);
    const widths = Array.from({length: usedColumns}, () => 0);
    const heights = [];
    panels.forEach((panel, position) => {
        const column = position % usedColumns;
        const row = Math.floor(position / usedColumns);
        widths[column] = Math.max(widths[column], panel.width);
        heights[row] = Math.max(heights[row] || 0, panel.height);
    });
    const gap = 28;
    const margin = 20;
    const titleHeight = source.title ? 32 : 0;
    const offsets = sizes => sizes.map((value, position) => margin + sizes.slice(0, position).reduce((sum, size) => sum + size + gap, 0));
    const xs = offsets(widths);
    const ys = offsets(heights).map(y => y + titleHeight);
    const width = Math.max(widths.reduce((sum, size) => sum + size, 0) + gap * (usedColumns - 1) + margin * 2,
        source.title ? textWidth(source.title, 18) + margin * 2 : 0);
    const height = heights.reduce((sum, size) => sum + size, 0) + gap * (heights.length - 1) + margin * 2 + titleHeight;
    return ['svg', {id: 'svgcontent_' + index, width, height, viewBox: '0 0 ' + width + ' ' + height, fill: '#000'},
        // processAll marks every assign diagram as a stylesheet provider. Emit
        // legacy CSS even for a cell-only first diagram so later classic gates
        // with notFirstAssign=true still receive their shared styles.
        assignStyles(),
        ['rect', {width, height, fill: 'white', stroke: 'none'}],
        ...(source.title ? [['text', {x: margin, y: 26, style: 'font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;fill:#182b3a'}, escapeText(source.title)]] : []),
        ...panels.map((panel, position) => ['g', {transform: 'translate(' + xs[position % usedColumns] + ',' + ys[Math.floor(position / usedColumns)] + ')'}, panel.svg])
    ];
}

module.exports = renderAssign;
