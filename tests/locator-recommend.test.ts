/**
 * recommendLocators — the locator ladder applied to one screen for get_element_tree: Android resource-id →
 * accessibility id → @text xpath; iOS accessibility id → @label xpath. A rung is used only when it is unique.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { recommendLocators, formatRecommendation, xpathLiteral } from '../src/utils/locator-recommend.js';

describe('recommendLocators — Android', () => {
  it('prefers a unique resource-id, then content-desc, then text', () => {
    const r = recommendLocators([
      { resourceId: 'com.x:id/login', text: 'Login' },
      { contentDesc: 'Settings', text: 'Settings' },
      { text: 'Forgot password?' },
    ], 'android');
    assert.deepEqual(r[0], { strategy: 'id', selector: 'com.x:id/login', matches: 1 });
    assert.deepEqual(r[1], { strategy: 'accessibility id', selector: 'Settings', matches: 1 });
    assert.deepEqual(r[2], { strategy: 'xpath', selector: "//*[@text='Forgot password?']", matches: 1 });
  });

  it('a duplicated resource-id (list rows) falls through to a unique text; all-duplicate is flagged', () => {
    const r = recommendLocators([
      { resourceId: 'com.x:id/row', text: 'Alpha' },
      { resourceId: 'com.x:id/row', text: 'Beta' },
      { resourceId: 'com.x:id/cell' },
      { resourceId: 'com.x:id/cell' },
    ], 'android');
    assert.deepEqual(r[0], { strategy: 'xpath', selector: "//*[@text='Alpha']", matches: 1 });
    assert.deepEqual(r[2], { strategy: 'id', selector: 'com.x:id/cell', matches: 2 });
    assert.match(formatRecommendation(r[2]), /matches 2 elements here — narrow it/);
  });

  it('nothing to locate by → null with advice', () => {
    assert.equal(recommendLocators([{}], 'android')[0], null);
    assert.match(formatRecommendation(null), /no stable locator/);
  });
});

describe('recommendLocators — iOS', () => {
  it('accessibility id (name) first; a duplicate name falls through to a unique label', () => {
    const r = recommendLocators([
      { name: 'loginButton', label: 'Log in' },
      { name: 'cell', label: 'Alpha' },
      { name: 'cell', label: 'Beta' },
    ], 'ios');
    assert.deepEqual(r[0], { strategy: 'accessibility id', selector: 'loginButton', matches: 1 });
    assert.deepEqual(r[1], { strategy: 'xpath', selector: "//*[@label='Alpha']", matches: 1 });
  });
});

describe('xpathLiteral', () => {
  it('quotes with whichever quote the value lacks; both kinds → null (no XPath 1.0 literal)', () => {
    assert.equal(xpathLiteral('Log in'), "'Log in'");
    assert.equal(xpathLiteral("Don't"), '"Don\'t"');
    assert.equal(xpathLiteral(`It's "x"`), null);
    // A text with both quote kinds gets no xpath rung — the content-desc / id rung (or null) is used instead.
    assert.equal(recommendLocators([{ text: `It's "x"` }], 'android')[0], null);
  });
});

describe('get_element_tree table carries the recommendation', () => {
  it('Android XML → table + "Recommended locator per element" lines', async () => {
    const { __elementTreeForTests } = await import('../src/tools/inspection-tools.js');
    const xml = '<hierarchy><android.widget.EditText resource-id="com.x:id/user" text="" clickable="true" bounds="[0,0][10,10]"/>' +
      '<android.widget.TextView resource-id="com.x:id/row" text="Alpha" bounds="[0,10][10,20]"/>' +
      '<android.widget.TextView resource-id="com.x:id/row" text="Beta" bounds="[0,20][10,30]"/></hierarchy>';
    const { elements, totalNodes } = __elementTreeForTests.parseElementTree(xml, 'android');
    const table = __elementTreeForTests.formatElementTable(elements, totalNodes, 'android');
    assert.match(table, /Recommended locator per element/);
    assert.match(table, /EditText "user" → id: com\.x:id\/user/);
    assert.match(table, /TextView "Alpha" → xpath: \/\/\*\[@text='Alpha'\]/);
  });
});

describe('get_element_tree flags a screen without resource-ids (likely Compose without testTagsAsResourceId)', () => {
  it('three or more located elements and none with a resource-id → the Compose hint', async () => {
    const { __elementTreeForTests } = await import('../src/tools/inspection-tools.js');
    const xml = '<hierarchy><android.view.View text="Pay" bounds="[0,0][1,1]"/><android.view.View text="Cancel" bounds="[0,1][1,2]"/>' +
      '<android.view.View content-desc="Back" bounds="[0,2][1,3]"/></hierarchy>';
    const { elements, totalNodes } = __elementTreeForTests.parseElementTree(xml, 'android');
    assert.match(__elementTreeForTests.formatElementTable(elements, totalNodes, 'android'), /testTagsAsResourceId = true/);
    const withIds = '<hierarchy><android.widget.Button resource-id="a:id/x" text="Pay" bounds="[0,0][1,1]"/><android.view.View text="b" bounds="[0,0][1,1]"/><android.view.View text="c" bounds="[0,0][1,1]"/></hierarchy>';
    const p = __elementTreeForTests.parseElementTree(withIds, 'android');
    assert.doesNotMatch(__elementTreeForTests.formatElementTable(p.elements, p.totalNodes, 'android'), /testTagsAsResourceId/);
  });
});
