"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const editor = fs.readFileSync(path.join(__dirname, "..", "nodes", "nodered-metrics.html"), "utf8");

test("extra-label editor restores and saves the typed-input value and type", () => {
  assert.match(editor, /type: row\.valueType \|\| 'str',\s*types: \['str', 'msg', 'flow', 'global', 'env'\],\s*typeField: typeField/s);
  assert.match(editor, /value: value\.typedInput\('value'\),\s*valueType: value\.typedInput\('type'\)/s);
});

test("editor validates metric labels and exporter paths before deployment", () => {
  assert.match(editor, /labelNames: \{ value: '', validate: function\(v\)/);
  assert.match(editor, /names\.every\(\(name, index\) => \/\^\[a-zA-Z_\]/);
  assert.match(editor, /path: \{ value: '\/nodeRedMetrics', required: true, validate: function\(v\) \{ return \/\^\\\/\\S\*\$\//);
});
