import { posix } from 'node:path';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { legacyWorkbookUnverified } from './zip-validation.js';

const sheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationship = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const contentType = 'http://schemas.openxmlformats.org/package/2006/content-types';
const types = new Map([
  [
    '/xl/workbook.xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  ],
  ['/xl/styles.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'],
  [
    '/xl/sharedStrings.xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  ],
  ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
  ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
]);
const forbidden = new Set([
  'f',
  'formula',
  'formula1',
  'formula2',
  'definedName',
  'externalReference',
  'externalReferences',
  'externalLink',
  'oleObject',
  'oleObjects',
  'control',
  'controls',
  'ddeLink',
  'oleLink',
  'connection',
  'connections',
  'queryTable',
  'hyperlink',
  'hyperlinks',
]);
const worksheetTags = new Set([
  'worksheet',
  'sheetPr',
  'outlinePr',
  'pageSetUpPr',
  'sheetViews',
  'sheetView',
  'selection',
  'sheetFormatPr',
  'dimension',
  'cols',
  'col',
  'sheetData',
  'row',
  'c',
  'v',
  'is',
  't',
  'pageMargins',
  'r',
  'rPr',
  'rFont',
  'b',
  'i',
  'u',
  'strike',
  'color',
  'sz',
  'family',
  'scheme',
  'charset',
  'vertAlign',
]);
const workbookTags = new Set([
  'workbook',
  'fileVersion',
  'workbookPr',
  'workbookProtection',
  'bookViews',
  'workbookView',
  'sheets',
  'sheet',
  'definedNames',
  'calcPr',
]);
const attribute = (tag: SaxesTagNS, name: string) => {
  const value = tag.attributes[name];
  return value?.value;
};
export interface WorkbookXmlState {
  names: Set<string>;
  overrides: Map<string, string>;
  relationships: Map<string, Map<string, string>>;
  sheets: { name: string; relationship: string }[];
}
export function workbookXmlValidator(part: string, state: WorkbookXmlState) {
  const parser = new SaxesParser({ xmlns: true, position: false });
  let depth = 0,
    textRun = 0,
    tagRun = 0,
    inTag = false,
    quote = '',
    previous = '';
  const relationshipIds = new Map<string, string>();
  const expectedRoot =
    part === '[Content_Types].xml'
      ? 'Types'
      : part.endsWith('.rels')
        ? 'Relationships'
        : part === 'xl/workbook.xml'
          ? 'workbook'
          : part === 'xl/styles.xml'
            ? 'styleSheet'
            : part === 'xl/sharedStrings.xml'
              ? 'sst'
              : part.startsWith('xl/worksheets/')
                ? 'worksheet'
                : part.startsWith('xl/theme/')
                  ? 'theme'
                  : part === 'docProps/app.xml'
                    ? 'Properties'
                    : 'coreProperties';
  const namespaces = part.startsWith('xl/theme/')
    ? ['http://schemas.openxmlformats.org/drawingml/2006/main']
    : part === 'docProps/app.xml'
      ? [
          'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
          'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes',
        ]
      : part === 'docProps/core.xml'
        ? [
            'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
            'http://purl.org/dc/elements/1.1/',
            'http://purl.org/dc/terms/',
            'http://purl.org/dc/dcmitype/',
          ]
        : part === '[Content_Types].xml'
          ? [contentType]
          : part.endsWith('.rels')
            ? [relationship]
            : [sheet];
  const fail = () => {
    throw legacyWorkbookUnverified();
  };
  parser.on('error', fail);
  parser.on('doctype', fail);
  parser.on('processinginstruction', fail);
  parser.on('xmldecl', (value) => {
    if (value.version !== '1.0' || (value.encoding && value.encoding.toLowerCase() !== 'utf-8'))
      fail();
  });
  parser.on('opentag', (tag) => {
    if (++depth > 64 || forbidden.has(tag.local)) fail();
    if (!namespaces.includes(tag.uri) || (depth === 1 && tag.local !== expectedRoot)) fail();
    for (const value of Object.values(tag.attributes))
      if (['href', 'src', 'schemaLocation'].includes(value.local)) fail();
    if (part.startsWith('xl/worksheets/') && !worksheetTags.has(tag.local)) fail();
    if (part === 'xl/workbook.xml' && !workbookTags.has(tag.local)) fail();
    if (part.endsWith('.rels')) {
      if (tag.uri !== relationship || !['Relationships', 'Relationship'].includes(tag.local))
        fail();
      if (tag.local === 'Relationship') {
        const id = attribute(tag, 'Id'),
          type = attribute(tag, 'Type'),
          target = attribute(tag, 'Target'),
          mode = attribute(tag, 'TargetMode');
        if (
          !id ||
          !type ||
          !target ||
          (mode !== undefined && mode !== 'Internal') ||
          /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) ||
          target.startsWith('//') ||
          /[\\\p{C}?#%]/u.test(target) ||
          target.split('/').some((value) => value === '.' || value === '..')
        )
          fail();
        const base = part === '_rels/.rels' ? '' : 'xl',
          name = target!.startsWith('/') ? target!.slice(1) : posix.join(base, target!);
        if (!state.names.has(name) || relationshipIds.has(id!)) fail();
        const allowed =
          part === '_rels/.rels'
            ? new Set([
                officeRelationship + '/officeDocument',
                'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
                officeRelationship + '/extended-properties',
              ])
            : new Set([
                officeRelationship + '/worksheet',
                officeRelationship + '/styles',
                officeRelationship + '/theme',
                officeRelationship + '/sharedStrings',
              ]);
        if (!allowed.has(type!)) fail();
        if (type === officeRelationship + '/officeDocument' && name !== 'xl/workbook.xml') fail();
        if (
          type === officeRelationship + '/worksheet' &&
          !/^xl\/worksheets\/sheet[1-9]\d*\.xml$/.test(name)
        )
          fail();
        if (type === officeRelationship + '/styles' && name !== 'xl/styles.xml') fail();
        if (type === officeRelationship + '/sharedStrings' && name !== 'xl/sharedStrings.xml')
          fail();
        if (type === officeRelationship + '/theme' && !/^xl\/theme\/theme\d+\.xml$/.test(name))
          fail();
        if (type!.endsWith('/metadata/core-properties') && name !== 'docProps/core.xml') fail();
        if (type === officeRelationship + '/extended-properties' && name !== 'docProps/app.xml')
          fail();
        relationshipIds.set(id!, name);
      }
    }
    if (part === '[Content_Types].xml') {
      if (tag.uri !== contentType || !['Types', 'Default', 'Override'].includes(tag.local)) fail();
      if (tag.local === 'Default') {
        const extension = attribute(tag, 'Extension'),
          type = attribute(tag, 'ContentType');
        if (!(
          (extension === 'xml' && type === 'application/xml') ||
          (extension === 'rels' &&
            type === 'application/vnd.openxmlformats-package.relationships+xml')
        ))
          fail();
      }
      if (tag.local === 'Override') {
        const name = attribute(tag, 'PartName'),
          type = attribute(tag, 'ContentType');
        const expected =
          name && /^\/xl\/worksheets\/sheet[1-9]\d*\.xml$/.test(name)
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
            : name && /^\/xl\/theme\/theme\d+\.xml$/.test(name)
              ? 'application/vnd.openxmlformats-officedocument.theme+xml'
              : types.get(name ?? '');
        if (
          !name ||
          !type ||
          type !== expected ||
          !state.names.has(name.slice(1)) ||
          state.overrides.has(name)
        )
          fail();
        state.overrides.set(name!, type!);
      }
    }
    if (tag.uri === sheet && tag.local === 'sheet') {
      const name = attribute(tag, 'name'),
        id = Object.values(tag.attributes).find(
          (value) => value.uri === officeRelationship && value.local === 'id',
        )?.value;
      if (
        !name ||
        name.length > 31 ||
        /[\\/*?:\[\]\p{C}]/u.test(name) ||
        !id ||
        state.sheets.some((value) => value.name.toLowerCase() === name.toLowerCase())
      )
        fail();
      state.sheets.push({ name: name!, relationship: id! });
    }
    if (tag.uri === sheet && tag.local === 'row') {
      const row = attribute(tag, 'r');
      if (row && (!/^\d{1,7}$/.test(row) || Number(row) < 1 || Number(row) > 1048576)) fail();
    }
    if (tag.uri === sheet && tag.local === 'c') {
      const reference = attribute(tag, 'r'),
        type = attribute(tag, 't');
      if (type && !['n', 's', 'str', 'inlineStr', 'b', 'e', 'd'].includes(type)) fail();
      if (reference) {
        const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(reference);
        if (!match || Number(match[2]) > 1048576) fail();
        let column = 0;
        for (const character of match![1]!) column = column * 26 + character.charCodeAt(0) - 64;
        if (column > 16384) fail();
      }
    }
  });
  parser.on('closetag', () => {
    depth--;
  });
  parser.on('text', (value) => {
    if (value.length > 65534) fail();
  });
  return {
    write(value: string) {
      // Bound token growth BEFORE feeding a streaming parser. DTD/CDATA/comments
      // are not part of source exports and cannot hide an unbounded buffer.
      if ((previous + value).includes('<!')) fail();
      previous = value.slice(-1);
      for (const character of value) {
        if (inTag) {
          if (++tagRun > 8192) fail();
          if (quote) {
            if (character === quote) quote = '';
          } else if (character === '"' || character === "'") quote = character;
          else if (character === '>') {
            inTag = false;
            textRun = 0;
          }
        } else if (character === '<') {
          inTag = true;
          tagRun = 1;
        } else if (++textRun > 327670) fail();
      }
      parser.write(value);
    },
    close() {
      parser.close();
      if (part.endsWith('.rels')) state.relationships.set(part, relationshipIds);
    },
  };
}
export function finishWorkbookXml(state: WorkbookXmlState) {
  if (!state.overrides.has('/xl/workbook.xml') || !state.sheets.length || state.sheets.length > 500)
    throw legacyWorkbookUnverified();
  const root = state.relationships.get('_rels/.rels'),
    workbook = state.relationships.get('xl/_rels/workbook.xml.rels');
  if (!root || ![...root.values()].includes('xl/workbook.xml') || !workbook)
    throw legacyWorkbookUnverified();
  for (const value of state.sheets) {
    const part = workbook.get(value.relationship);
    if (
      !part ||
      !/^xl\/worksheets\/sheet[1-9]\d*\.xml$/.test(part) ||
      !state.overrides.has('/' + part)
    )
      throw legacyWorkbookUnverified();
  }
}
