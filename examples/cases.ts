import type { Case } from "../src/index.ts";

export const cases: Case[] = [
  {
    name: "off-by-one",
    files: {
      "sum.js": "exports.sumTo = (n) => { let s = 0; for (let i = 1; i < n; i++) s += i; return s; };\n",
      "test.js": "const a = require('assert'); const { sumTo } = require('./sum'); a.equal(sumTo(3), 6); a.equal(sumTo(1), 1);\n",
    },
    task: "sumTo(n) should return 1+2+...+n but tests fail. Fix the bug.",
    verify: "node test.js",
    check: "node test.js && node -e \"const {sumTo}=require('./sum');process.exit(sumTo(10)===55&&sumTo(0)===0?0:1)\"",
  },
  {
    name: "missing-feature",
    files: {
      "slug.js": "exports.slugify = (s) => s.toLowerCase().replace(/ /g, '-');\n",
      "test.js": "const a = require('assert'); const { slugify } = require('./slug'); a.equal(slugify('Hello World'), 'hello-world'); a.equal(slugify(' Café  au lait! '), 'cafe-au-lait');\n",
    },
    task: "slugify must also strip accents and punctuation, trim, and collapse repeated separators. Make test.js pass.",
    verify: "node test.js",
    check: "node test.js && node -e \"const {slugify}=require('./slug');process.exit(slugify('A--B  C!!')==='a-b-c'?0:1)\"",
  },
  {
    name: "rename-across-files",
    files: {
      "a.js": "exports.getUsr = () => ({ name: 'x' });\n",
      "b.js": "const { getUsr } = require('./a'); exports.hello = () => 'hi ' + getUsr().name;\n",
      "test.js": "const a = require('assert'); a.equal(require('./b').hello(), 'hi x'); a.equal(typeof require('./a').getUser, 'function');\n",
    },
    task: "Rename getUsr to getUser everywhere in this repo.",
    verify: "node test.js",
    check: "node test.js && ! grep -r getUsr a.js b.js",
  },
];
