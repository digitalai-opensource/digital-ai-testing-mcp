import { describe, it, assert } from 'vitest';
import { parseScreen, screenSignature, classifyTap, isLoading, hasWords, candidateTaps, locatorFor } from '../src/utils/app-exploration.js';

// Page sources shaped like three different customer apps (none is the sample app): rules that fit one app only fail here.

const shopHome = (feedText: string, balance: string) => `<?xml version="1.0"?><hierarchy>
<android.widget.FrameLayout class="android.widget.FrameLayout" bounds="[0,0][1080,2340]" clickable="false" enabled="true">
  <android.widget.TextView class="android.widget.TextView" resource-id="com.acme.shop:id/balance" text="${balance}" bounds="[40,120][600,200]" clickable="false" enabled="true"/>
  <androidx.recyclerview.widget.RecyclerView class="androidx.recyclerview.widget.RecyclerView" resource-id="com.acme.shop:id/feed" bounds="[0,220][1080,2000]" clickable="false" enabled="true">
    <android.widget.LinearLayout class="android.widget.LinearLayout" resource-id="com.acme.shop:id/product_row" bounds="[0,220][1080,420]" clickable="true" enabled="true">
      <android.widget.TextView class="android.widget.TextView" resource-id="com.acme.shop:id/title" text="${feedText}" bounds="[40,240][800,300]" clickable="false" enabled="true"/>
    </android.widget.LinearLayout>
    <android.widget.LinearLayout class="android.widget.LinearLayout" resource-id="com.acme.shop:id/product_row" bounds="[0,420][1080,620]" clickable="true" enabled="true">
      <android.widget.TextView class="android.widget.TextView" resource-id="com.acme.shop:id/title" text="Shoes" bounds="[40,440][800,500]" clickable="false" enabled="true"/>
    </android.widget.LinearLayout>
    <android.widget.LinearLayout class="android.widget.LinearLayout" resource-id="com.acme.shop:id/product_row" bounds="[0,620][1080,820]" clickable="true" enabled="true">
      <android.widget.TextView class="android.widget.TextView" resource-id="com.acme.shop:id/title" text="Hats" bounds="[40,640][800,700]" clickable="false" enabled="true"/>
    </android.widget.LinearLayout>
  </androidx.recyclerview.widget.RecyclerView>
  <android.widget.Button class="android.widget.Button" resource-id="com.acme.shop:id/pay" text="Pay now" bounds="[40,2020][1040,2120]" clickable="true" enabled="true"/>
  <android.widget.ImageButton class="android.widget.ImageButton" resource-id="com.acme.shop:id/fab" bounds="[900,1800][1040,1940]" clickable="true" enabled="true"/>
  <com.google.android.material.bottomnavigation.BottomNavigationView class="com.google.android.material.bottomnavigation.BottomNavigationView" bounds="[0,2140][1080,2340]" clickable="false" enabled="true">
    <android.widget.FrameLayout class="android.widget.FrameLayout" content-desc="Home" bounds="[0,2140][360,2340]" clickable="true" enabled="true"/>
    <android.widget.FrameLayout class="android.widget.FrameLayout" content-desc="Orders" bounds="[360,2140][720,2340]" clickable="true" enabled="true"/>
    <android.widget.FrameLayout class="android.widget.FrameLayout" content-desc="Account" bounds="[720,2140][1080,2340]" clickable="true" enabled="true"/>
  </com.google.android.material.bottomnavigation.BottomNavigationView>
</android.widget.FrameLayout></hierarchy>`;

const loginForm = `<hierarchy><android.widget.FrameLayout class="android.widget.FrameLayout" bounds="[0,0][1080,2340]" clickable="false" enabled="true">
  <android.widget.EditText class="android.widget.EditText" resource-id="org.example.bank:id/user" text="" bounds="[40,600][1040,700]" clickable="true" enabled="true"/>
  <android.widget.EditText class="android.widget.EditText" resource-id="org.example.bank:id/pin" text="" bounds="[40,720][1040,820]" clickable="true" enabled="true"/>
  <android.widget.Button class="android.widget.Button" resource-id="org.example.bank:id/signin" text="Sign in" bounds="[40,860][1040,960]" clickable="true" enabled="true"/>
  <android.widget.Switch class="android.widget.Switch" resource-id="org.example.bank:id/remember" text="Remember me" checkable="true" bounds="[40,980][1040,1060]" clickable="true" enabled="true"/>
  <android.widget.TextView class="android.widget.TextView" text="Help" bounds="[40,1100][300,1160]" clickable="true" enabled="true"/>
</android.widget.FrameLayout></hierarchy>`;

const iosSettings = (title: string) => `<?xml version="1.0" encoding="UTF-8"?><AppiumAUT>
<XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Notes Pro" label="Notes Pro" enabled="true" visible="true" x="0" y="0" width="390" height="844">
  <XCUIElementTypeNavigationBar type="XCUIElementTypeNavigationBar" name="${title}" enabled="true" visible="true" x="0" y="47" width="390" height="44">
    <XCUIElementTypeButton type="XCUIElementTypeButton" name="Back" label="Back" enabled="true" visible="true" x="0" y="47" width="80" height="44"/>
    <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="${title}" label="${title}" enabled="true" visible="true" x="150" y="58" width="90" height="22"/>
  </XCUIElementTypeNavigationBar>
  <XCUIElementTypeTable type="XCUIElementTypeTable" enabled="true" visible="true" x="0" y="91" width="390" height="700">
    <XCUIElementTypeCell type="XCUIElementTypeCell" name="folder_cell" label="Work" enabled="true" visible="true" x="0" y="91" width="390" height="44"/>
    <XCUIElementTypeCell type="XCUIElementTypeCell" name="folder_cell" label="Personal" enabled="true" visible="true" x="0" y="135" width="390" height="44"/>
    <XCUIElementTypeSwitch type="XCUIElementTypeSwitch" name="sync" label="iCloud sync" value="1" enabled="true" visible="true" x="300" y="180" width="51" height="31"/>
  </XCUIElementTypeTable>
  <XCUIElementTypeButton type="XCUIElementTypeButton" name="Delete All" label="Delete All" enabled="true" visible="true" x="20" y="790" width="350" height="44"/>
  <XCUIElementTypeTabBar type="XCUIElementTypeTabBar" enabled="true" visible="true" x="0" y="795" width="390" height="49">
    <XCUIElementTypeButton type="XCUIElementTypeButton" name="Notes" label="Notes" enabled="true" visible="true" x="0" y="795" width="195" height="49"/>
    <XCUIElementTypeButton type="XCUIElementTypeButton" name="Search" label="Search" enabled="true" visible="true" x="195" y="795" width="195" height="49"/>
  </XCUIElementTypeTabBar>
  <XCUIElementTypeButton type="XCUIElementTypeButton" name="hidden" label="Hidden" enabled="true" visible="false" x="0" y="0" width="1" height="1"/>
</XCUIElementTypeApplication></AppiumAUT>`;

describe('screenSignature: the same screen whatever its content, different screens apart', () => {
  it('a feed, a balance or row text that changes per visit does not create a new screen', () => {
    const a = screenSignature(parseScreen(shopHome('Jacket', '$120.00'), 'android'), '.HomeActivity');
    const b = screenSignature(parseScreen(shopHome('Umbrella', '$95.10'), 'android'), '.HomeActivity');
    assert.equal(a, b);
  });
  it('different screens differ: another activity, another layout, another iOS navigation title', () => {
    const home = parseScreen(shopHome('Jacket', '$1'), 'android');
    assert.notEqual(screenSignature(home, '.HomeActivity'), screenSignature(home, '.OrdersActivity'));
    assert.notEqual(screenSignature(home, '.MainActivity'), screenSignature(parseScreen(loginForm, 'android'), '.MainActivity'));
    assert.notEqual(screenSignature(parseScreen(iosSettings('Folders'), 'ios')), screenSignature(parseScreen(iosSettings('Settings'), 'ios')));
  });
  it('rows of one list template count once: three rows and two rows give the same screen', () => {
    const three = shopHome('A', '1');
    const two = three.replace(/<android\.widget\.LinearLayout[^>]*bounds="\[0,620\]\[1080,820\]"[\s\S]*?<\/android\.widget\.LinearLayout>/, '');
    assert.equal(screenSignature(parseScreen(three, 'android'), '.Home'), screenSignature(parseScreen(two, 'android'), '.Home'));
  });
});

describe('classifyTap: an allow-list of navigation, never a guess', () => {
  const byId = (els: ReturnType<typeof parseScreen>, id: string) => els.find((e) => e.id === id || e.description === id || e.text === id)!;
  it('Android: tabs and list rows are navigation; Pay, an icon-only button, a switch and text fields are not tapped', () => {
    const els = parseScreen(shopHome('Jacket', '$1'), 'android');
    assert.equal(classifyTap(byId(els, 'Orders')).kind, 'navigation');
    assert.equal(classifyTap(byId(els, 'com.acme.shop:id/product_row')).kind, 'navigation');
    assert.equal(classifyTap(byId(els, 'com.acme.shop:id/pay')).kind, 'action');
    assert.match(classifyTap(byId(els, 'com.acme.shop:id/fab')).reason, /icon-only/);
    const login = parseScreen(loginForm, 'android');
    assert.equal(classifyTap(byId(login, 'org.example.bank:id/user')).kind, 'input');
    assert.equal(classifyTap(byId(login, 'org.example.bank:id/remember')).kind, 'action');
    assert.equal(classifyTap(byId(login, 'org.example.bank:id/signin')).kind, 'action', 'a sign-in button is a write path (accounts), never navigation');
    assert.equal(classifyTap(byId(login, 'Help')).kind, 'navigation', 'a whole-label navigation word');
  });
  it('iOS: tab buttons, cells and the navigation bar’s Back are navigation; Delete All and a switch are not; invisible elements are ignored', () => {
    const els = parseScreen(iosSettings('Folders'), 'ios');
    assert.equal(classifyTap(byId(els, 'Search')).kind, 'navigation');
    assert.equal(classifyTap(byId(els, 'folder_cell')).kind, 'navigation');
    assert.equal(classifyTap(byId(els, 'Back')).kind, 'navigation');
    assert.equal(classifyTap(byId(els, 'Delete All')).kind, 'destructive');
    assert.equal(classifyTap(byId(els, 'sync')).kind, 'action');
    assert.equal(els.some((e) => e.id === 'hidden'), false);
  });
});

describe('drop-downs are picked, never typed (DAI Bank Bill Pay, live tree 2026-11-28)', () => {
  // Compose's drop-down: a clickable EditText showing the value, its caption and a Spinner inside; a plain text field has none.
  const node = (cls: string, a: string, inner = '') => `<${cls} class="${cls}" ${a}>${inner}</${cls}>`;
  const billPay = `<hierarchy>${node('android.widget.ScrollView', 'clickable="false" bounds="[0,0][1080,2340]"', [
    node('android.widget.TextView', 'text="Bill Pay" clickable="false" bounds="[45,299][249,371]"'),
    node('android.widget.EditText', 'text="Electric Company" clickable="true" bounds="[45,416][1035,597]"',
      node('android.widget.TextView', 'text="Payee" clickable="false" bounds="[90,417][189,462]"') + node('android.widget.Spinner', 'text="" clickable="true" bounds="[900,451][1000,586]"')),
    node('android.widget.ImageView', 'text="" package="com.android.systemui" resource-id="com.android.systemui:id/recent_apps" clickable="true" bounds="[700,2210][900,2340]"'),
    node('android.widget.EditText', 'text="" clickable="true" bounds="[45,868][1035,1049]"', node('android.widget.TextView', 'text="Amount" clickable="false" bounds="[90,869][250,910]"')),
    node('android.widget.Spinner', 'text="" resource-id="com.acme:id/when" clickable="true" bounds="[45,1100][1035,1200]"', node('android.widget.TextView', 'text="Today" clickable="false" bounds="[90,1110][250,1190]"')),
  ].join(''))}</hierarchy>`;
  it('a field with a Spinner inside, and a Spinner itself, are drop-downs with their caption; a plain field stays a text field', () => {
    const els = parseScreen(billPay, 'android');
    const payee = els.find((e) => e.text === 'Electric Company')!;
    assert.equal(payee.choice, true);
    assert.equal(payee.caption, 'Payee');
    assert.equal(classifyTap(payee).kind, 'choice');
    assert.equal(classifyTap(payee, true).kind, 'choice', 'write paths do not make a drop-down something to type into');
    const amount = els.find((e) => e.type === 'android.widget.EditText' && !e.text)!;
    assert.equal(amount.choice, undefined);
    assert.equal(classifyTap(amount).kind, 'input');
    assert.equal(amount.caption, 'Amount');
    assert.equal(classifyTap(els.find((e) => e.id === 'com.acme:id/when')!).kind, 'choice');
    assert.equal(els.filter((e) => e.choice).length, 2, 'the arrow inside a drop-down is part of it, not a second one');
    // The Appium Grid's tree holds the phone's navigation bar: never the app's, never a route.
    assert.equal(els.some((e) => e.id?.includes('recent_apps')), false);
    assert.equal(parseScreen(billPay, 'android', { keepSystemUi: true }).some((e) => e.id?.includes('recent_apps')), true, 'kept when the system UI is in front (its dialog)');
    // Another app's overlay (Samsung's edge panel handle) is left out while the app is in front; Android's own dialogs stay.
    const overlay = billPay.replace('</hierarchy>', '<android.widget.FrameLayout class="android.widget.FrameLayout" package="com.samsung.android.app.cocktailbarservice" content-desc="Edge panels" clickable="true" bounds="[1060,600][1080,900]"></android.widget.FrameLayout><android.widget.Button class="android.widget.Button" package="android" text="Close app" clickable="true" bounds="[100,1000][900,1100]"></android.widget.Button></hierarchy>');
    const own = parseScreen(overlay, 'android', { appPackage: 'com.acme' });
    assert.equal(own.some((e) => e.description === 'Edge panels'), false);
    assert.equal(own.some((e) => e.text === 'Close app'), true);
    assert.equal(parseScreen(overlay, 'android').some((e) => e.description === 'Edge panels'), true, 'kept when the app in front is not known');
  });
  it('a form flow lists its drop-downs apart from the fields to type, with the options the crawl read', async () => {
    const { proposeFlows } = await import('../src/utils/exploration-flows.js');
    const x = (v: string) => ({ using: 'xpath' as const, value: v });
    const m = {
      app: { platform: 'android', appId: 'com.acme.bank' }, device: { name: 'P', os: 'Android', version: '14' }, startedAt: '', stoppedBecause: '', taps: 1, notes: [],
      screens: [{ signature: 's', title: 'Bill Pay', foreground: null, path: [{ label: 'Bill Pay', locator: x("//*[@text='Bill Pay']") }], elements: 9, assertable: [], navigation: [],
        notVisited: [
          { label: 'Electric Company', field: 'Payee', kind: 'choice', reason: '', locator: x("(//*[contains(@class,'EditText')])[1]"), options: ['Electric Company', 'Water Utility'] },
          { label: 'Amount', kind: 'input', reason: '', locator: x("(//*[contains(@class,'EditText')])[2]") },
          { label: 'Pay Bill', kind: 'unknown', reason: '', locator: x("//*[@text='Pay Bill']") },
        ] }],
    };
    const form = proposeFlows(m as never).find((f) => f.kind === 'form')!;
    assert.deepEqual(form.needsData, ['Amount']);
    assert.deepEqual(form.choices, [{ field: 'Payee', shown: 'Electric Company', options: ['Electric Company', 'Water Utility'] }]);
    const { codegenInput } = await import('../src/utils/exploration-flows.js');
    const ci = codegenInput(m as never, [form.id]);
    assert.deepEqual(ci.skipped, []);
    assert.equal(ci.flows[0].choices?.[0].label, 'Payee');
    assert.equal(ci.flows[0].fields?.[0].locator.value, "(//*[contains(@class,'EditText')])[2]");
  });
});

describe('candidateTaps: what the crawler visits and what it only records', () => {
  it('collapses the rows of one list template and records the rest as unvisited with a reason', () => {
    const { taps, unvisited } = candidateTaps(parseScreen(shopHome('Jacket', '$1'), 'android'));
    const rows = taps.filter((t) => t.element.inList);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].collapsed, 2);
    assert.deepEqual(taps.filter((t) => t.element.inNavigation === 'tabs').map((t) => t.element.description), ['Home', 'Orders', 'Account']);
    assert.ok(unvisited.some((u) => u.element.id === 'com.acme.shop:id/pay' && u.kind === 'action'));
    assert.ok(unvisited.some((u) => u.element.id === 'com.acme.shop:id/fab'));
  });
});

import { beforeAll, afterAll } from 'vitest';
import { startStubApi, connectTools, accountInfo, type StubApi, type ToolClient } from './helpers/offline.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerExplorationTools } from '../src/tools/exploration-tools.js';

describe('start_app_exploration: the user\u2019s app, its version and its OS first; never a stand-in', () => {
  let stub: StubApi;
  let t: ToolClient;
  beforeAll(async () => {
    stub = await startStubApi((req) => {
      if (req.path === '/api/v1/applications/7') return { id: 7, name: 'Shop', packageName: 'com.acme.shop', mainActivity: '.Main', releaseVersion: '4.2.0', osType: 'ANDROID' };
      if (req.path.startsWith('/api/v1/applications/')) return { __status: 404 } as never;
      return undefined;
    });
    t = await connectTools(registerExplorationTools);
  });
  afterAll(async () => { await t.close(); await stub.close(); });

  it('refuses without an app, without a version for a bare package, and for an iOS request on an Android record', async () => {
    let r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /Ask the user for their app, its version and its OS/);
    r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android', packageName: 'com.acme.shop' });
    assert.match(r.text, /appVersion is required/);
    r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'ios', appId: 7 });
    assert.match(r.text, /has no iOS bundle id/);
  });

  it('a test login is read from environment variables named by the caller; a missing one is refused without asking for the password', async () => {
    delete process.env.NO_SUCH_USER_VAR;
    const r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android', appId: 7, loginUserEnv: 'NO_SUCH_USER_VAR', loginPasswordEnv: 'NO_SUCH_PASS_VAR' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /never ask for the password in the chat/i);
    assert.match(r.text, /NO_SUCH_USER_VAR, NO_SUCH_PASS_VAR\./, 'names the variables that are missing');
    assert.match(r.text, /app-login <name>/, 'points to the saved-login route');
    assert.notMatch(r.text, /setx/);
  });

  it('testLogin: an unsaved name is refused with the command that saves it; not together with the env names', async () => {
    let r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android', appId: 7, testLogin: 'daibank' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /app-login daibank|credential store is switched off/);
    r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android', appId: 7, testLogin: 'daibank', loginUserEnv: 'A' });
    assert.match(r.text, /not both/);
  });

  it('without allowWritePaths: the app and login are checked first, then the question comes back, nothing started', async () => {
    let r = await t.call('start_app_exploration', { platform: 'android', appId: 7, testLogin: 'nosuch' });
    assert.equal(r.res.isError, true, 'a missing login is named before the write-paths question');
    assert.match(r.text, /app-login nosuch|credential store is switched off/);
    process.env.EXPLORE_Q_USER = 'qa-user-88'; process.env.EXPLORE_Q_PASS = 'q-Pass!';
    try {
      r = await t.call('start_app_exploration', { platform: 'android', appId: 7, loginUserEnv: 'EXPLORE_Q_USER', loginPasswordEnv: 'EXPLORE_Q_PASS', outputFormat: 'json' });
      assert.notEqual(r.res.isError, true, r.text);
      const j = JSON.parse(r.text);
      assert.equal(j.status, 'needs_answer');
      assert.equal(j.jobId, undefined, 'no job, no device');
      assert.notMatch(r.text, /qa-user-88|q-Pass!/);
      r = await t.call('start_app_exploration', { platform: 'android', appId: 7, loginUserEnv: 'EXPLORE_Q_USER', loginPasswordEnv: 'EXPLORE_Q_PASS' });
      assert.match(r.text, /ask the user ONE question[\s\S]*allowWritePaths = their answer/);
    } finally { delete process.env.EXPLORE_Q_USER; delete process.env.EXPLORE_Q_PASS; }
  });

  it('the start answer never contains the test login’s values, only where they come from', async () => {
    process.env.EXPLORE_T_USER = 'qa-user-77'; process.env.EXPLORE_T_PASS = 's3cret-Pass!';
    try {
      const r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android', appId: 7, loginUserEnv: 'EXPLORE_T_USER', loginPasswordEnv: 'EXPLORE_T_PASS', outputFormat: 'json' });
      assert.notEqual(r.res.isError, true, r.text);
      assert.notMatch(r.text, /qa-user-77|s3cret-Pass!/);
      assert.match(r.text, /from EXPLORE_T_USER \/ EXPLORE_T_PASS/);
      const id = JSON.parse(r.text).jobId as string;
      await t.call('app_exploration_status', { jobId: id, cancel: true });
    } finally { delete process.env.EXPLORE_T_USER; delete process.env.EXPLORE_T_PASS; }
  });

  it('an unknown job id is an error', async () => {
    const r = await t.call('app_exploration_status', { jobId: 'explore-none' });
    assert.equal(r.res.isError, true);
  });
});

describe('the write-paths setting and destructive actions (owner decisions 2026-11-27)', () => {
  // A Compose-style screen: tappable containers whose words are in child texts, no tab bar, no list widget.
  const compose = `<hierarchy><android.view.View class="android.view.View" bounds="[0,0][1080,2340]" clickable="false" enabled="true">
    <android.view.View class="android.view.View" bounds="[40,400][1040,520]" clickable="true" enabled="true"><android.widget.TextView class="android.widget.TextView" text="History" bounds="[60,420][400,500]" clickable="false" enabled="true"/></android.view.View>
    <android.view.View class="android.view.View" bounds="[40,540][1040,660]" clickable="true" enabled="true"><android.widget.TextView class="android.widget.TextView" text="Transfer" bounds="[60,560][400,640]" clickable="false" enabled="true"/></android.view.View>
    <android.view.View class="android.view.View" bounds="[40,680][1040,800]" clickable="true" enabled="true"><android.widget.TextView class="android.widget.TextView" text="Close Account" bounds="[60,700][500,780]" clickable="false" enabled="true"/></android.view.View>
    <android.view.View class="android.view.View" bounds="[40,820][1040,940]" clickable="true" enabled="true"><android.widget.TextView class="android.widget.TextView" text="Log Out" bounds="[60,840][400,920]" clickable="false" enabled="true"/></android.view.View>
  </android.view.View></hierarchy>`;
  const els = parseScreen(compose, 'android');
  const byWords = (w: string) => els.find((e) => e.innerText === w)!;

  it('a tappable container takes its words from its child text, and gets a locator from them', () => {
    assert.equal(byWords('History').clickable, true);
    assert.equal(locatorFor(byWords('History'), 'android')?.value, "//*[@clickable='true'][.//*[@text='History' or @content-desc='History']]");
  });
  it('without write paths only navigation is tapped; unknown buttons and write paths are recorded', () => {
    const { taps, unvisited } = candidateTaps(els, false);
    assert.deepEqual(taps.map((t) => t.element.innerText), []);
    assert.deepEqual(unvisited.map((u) => [u.element.innerText, u.kind]), [['History', 'unknown'], ['Transfer', 'action'], ['Close Account', 'destructive'], ['Log Out', 'destructive']]);
  });
  it('with write paths allowed, unknown buttons and write paths are tapped; destructive ones never are', () => {
    const { taps, unvisited } = candidateTaps(els, true);
    assert.deepEqual(taps.map((t) => t.element.innerText), ['History', 'Transfer']);
    assert.deepEqual(unvisited.map((u) => [u.element.innerText, u.kind]), [['Close Account', 'destructive'], ['Log Out', 'destructive']]);
    assert.match(unvisited[0].reason, /needs the user.s confirmation each time/);
  });
});

describe('read-only navigation by wording, and loaders (DAI Bank live run 2026-11-27)', () => {
  const screen = (inner: string) => parseScreen(`<hierarchy><android.view.View class="android.view.View" bounds="[0,0][1080,2340]" clickable="false" enabled="true">${inner}</android.view.View></hierarchy>`, 'android');
  const card = (t: string) => `<android.view.View class="android.view.View" bounds="[40,400][1040,520]" clickable="true" enabled="true"><android.widget.TextView class="android.widget.TextView" text="${t}" bounds="[60,420][400,500]" clickable="false" enabled="true"/></android.view.View>`;

  it('a card that says it opens something to view is navigation even read-only; a write word still wins', () => {
    assert.equal(classifyTap(screen(card('Checking Tap to view history $1,000.00')).find((e) => e.clickable)!, false).kind, 'navigation');
    assert.equal(classifyTap(screen(card('View statements')).find((e) => e.clickable)!, false).kind, 'navigation');
    assert.equal(classifyTap(screen(card('Tap to pay now')).find((e) => e.clickable)!, false).kind, 'action');
    assert.equal(classifyTap(screen(card('Tap to view and delete')).find((e) => e.clickable)!, true).kind, 'destructive');
  });

  it('a progress bar or a loading text means the screen has not settled; a drop-down is not a loader', () => {
    assert.equal(isLoading(screen('<android.widget.ProgressBar class="android.widget.ProgressBar" bounds="[500,1100][580,1180]" clickable="false" enabled="true"/>')), true);
    assert.equal(isLoading(screen('<android.widget.TextView class="android.widget.TextView" text="Loading accounts…" bounds="[60,420][400,500]" clickable="false" enabled="true"/>')), true);
    assert.equal(isLoading(screen('<android.widget.Spinner class="android.widget.Spinner" bounds="[60,420][400,500]" clickable="true" enabled="true"/>')), false);
    assert.equal(isLoading(screen(card('Checking'))), false);
  });
});

describe('the exact build, resuming, and unlabelled controls (Desktop test 2026-11-27)', () => {
  let stub: StubApi;
  let t: ToolClient;
  const dir = mkdtempSync(join(tmpdir(), 'dai-explore-'));
  const saved = process.env.MCP_EXPLORATION_DIR;
  beforeAll(async () => {
    process.env.MCP_EXPLORATION_DIR = dir;
    stub = await startStubApi((req) => {
      if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Mobile QA');
      if (req.path === '/api/v1/applications/8') return { id: 8, packageName: 'com.acme.shop', mainActivity: '.Main', releaseVersion: '4.3.0', buildVersion: '12', projectsInfo: [{ id: 9, name: 'Web Team' }] };
      if (req.path === '/api/v1/applications') return [
        { id: 8, packageName: 'com.acme.shop', releaseVersion: '4.3.0', buildVersion: '12', projectsInfo: [{ id: 9, name: 'Web Team' }] },
        { id: 5, packageName: 'com.acme.shop', releaseVersion: '4.2.0', buildVersion: '11', projectsInfo: [{ id: 1, name: 'Mobile QA' }] },
      ];
      return undefined;
    });
    t = await connectTools(registerExplorationTools);
  });
  afterAll(async () => { await t.close(); await stub.close(); if (saved === undefined) delete process.env.MCP_EXPLORATION_DIR; else process.env.MCP_EXPLORATION_DIR = saved; rmSync(dir, { recursive: true, force: true }); });

  it('a build of another project is refused, naming the builds the active project can install', async () => {
    const r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android', appId: 8 });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /assigned to Web Team, not to the active project Mobile QA/);
    assert.match(r.text, /5: version 4\.2\.0 build 11/);
    assert.match(r.text, /ASK THE USER[\s\S]*Never switch_environment on your own/, 'the agent asks before changing the profile');
  });

  it('resumeFrom: an unknown run, a finished run and a run of another platform are refused; a run with open routes continues', async () => {
    let r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android', resumeFrom: 'explore-nothere' });
    assert.match(r.text, /no saved exploration explore-nothere/);
    const base = { app: { platform: 'android', appId: 'com.acme.shop', activity: '.Main', version: '4.2.0', appReleaseVersion: '4.2.0', appBuildVersion: '11' }, device: { name: 'Pixel', os: 'Android', version: '14' }, startedAt: '2026-11-27T00:00:00Z', stoppedBecause: 'x', screens: [{ signature: 's1', title: 'Home', foreground: null, path: [], elements: 3, assertable: [], navigation: [], notVisited: [] }], taps: 0, notes: [], settings: { allowWritePaths: false, maxDepth: 6, loginRef: { testLogin: 'shop' } } };
    writeFileSync(join(dir, 'explore-done1.json'), JSON.stringify(base));
    r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android', resumeFrom: 'explore-done1' });
    assert.match(r.text, /no routes left to follow/);
    writeFileSync(join(dir, 'explore-open1.json'), JSON.stringify({ ...base, frontier: [{ screen: 'Home', label: 'Orders' }], settings: { allowWritePaths: false, maxDepth: 6 } }));
    r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'ios', resumeFrom: 'explore-open1' });
    assert.match(r.text, /android app, not ios/);
    r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android', resumeFrom: 'explore-open1', outputFormat: 'json' });
    assert.notEqual(r.res.isError, true, r.text);
    assert.match(r.text, /"resumes":"explore-open1"/);
    assert.match(r.text, /"releaseVersion":"4\.2\.0","buildVersion":"11"/, 'the earlier run’s build is pinned');
  });

  it('a saved run whose login is no longer saved is refused on resume, never run without it', async () => {
    const prev = JSON.parse(readFileSync(join(dir, 'explore-done1.json'), 'utf8'));
    writeFileSync(join(dir, 'explore-open2.json'), JSON.stringify({ ...prev, frontier: [{ screen: 'Home', label: 'Orders' }] }));
    const r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android', resumeFrom: 'explore-open2' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /test login|credential store/);
  });

  it('a control labelled only with punctuation has no label', () => {
    const els = parseScreen('<hierarchy><android.view.View class="android.view.View" bounds="[0,0][100,100]" clickable="true" enabled="true" text="▾"/></hierarchy>', 'android');
    assert.equal(hasWords(els[0]), false);
    assert.equal(classifyTap(els[0], false).kind, 'unknown');
  });
});

describe('resuming a run that mapped nothing', () => {
  it('says to start again on another phone instead of claiming the run is complete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dai-explore-empty-'));
    const saved = process.env.MCP_EXPLORATION_DIR;
    process.env.MCP_EXPLORATION_DIR = dir;
    const stub = await startStubApi(() => undefined);
    const t = await connectTools(registerExplorationTools);
    try {
      writeFileSync(join(dir, 'explore-empty1.json'), JSON.stringify({ app: { platform: 'android', appId: 'com.acme.shop' }, device: { name: 'Phone X', os: 'Android', version: '13' }, startedAt: '', stoppedBecause: 'the app did not come to the front (com.android.chrome stayed in front)', screens: [], taps: 0, notes: [] }));
      const r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android', resumeFrom: 'explore-empty1' });
      assert.equal(r.res.isError, true);
      assert.match(r.text, /mapped no screens/);
      assert.match(r.text, /another phone \(it ran on Phone X\)/);
    } finally {
      await t.close(); await stub.close();
      if (saved === undefined) delete process.env.MCP_EXPLORATION_DIR; else process.env.MCP_EXPLORATION_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('page-source text', () => {
  it('decodes numeric character references (iOS line breaks)', () => {
    const els = parseScreen('<AppiumAUT><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="a&#13;b &#x41;" label="a&#13;b &#x41;" enabled="true" visible="true" x="0" y="0" width="10" height="10"/></AppiumAUT>', 'ios');
    assert.equal(els[0].description ?? els[0].text, 'a\rb A');
  });
});

describe('similarScreen: one screen across visits, two screens apart', () => {
  it('matches a table that drew more rows, never different screens with one title or untitled screens', async () => {
    const { similarScreen } = await import('../src/utils/app-exploration.js');
    const buttons = (n: number) => ({ title: 'Buttons', fg: null, labels: ['Back', `Gray (+${n} similar rows)`, 'Rounded', 'More info'] });
    assert.equal(similarScreen(buttons(7), buttons(9)), true);
    assert.equal(similarScreen({ title: 'Details', fg: null, labels: ['Back', 'Edit order', 'Track parcel'] }, { title: 'Details', fg: null, labels: ['Back', 'Play', 'Add to list'] }), false);
    assert.equal(similarScreen({ title: '(untitled screen)', fg: null, labels: [] }, { title: '(untitled screen)', fg: null, labels: [] }), false);
    assert.equal(similarScreen({ title: 'Home', fg: '.A', labels: ['X'] }, { title: 'Home', fg: '.B', labels: ['X'] }), false);
  });
});

describe('similarScreen with a title that changed between visits', () => {
  it('matches a sizeable, nearly identical set of routes; not a small or different one', async () => {
    const { similarScreen } = await import('../src/utils/app-exploration.js');
    const routes = ['Buttons', 'Controls', 'TextFields', 'SearchBar', 'Pickers', 'Map'];
    assert.equal(similarScreen({ title: 'UICatalog', fg: null, labels: routes }, { title: 'Buttons', fg: null, labels: routes }), true);
    assert.equal(similarScreen({ title: 'A', fg: null, labels: ['Back', 'Save'] }, { title: 'B', fg: null, labels: ['Back', 'Save'] }), false);
    assert.equal(similarScreen({ title: 'A', fg: null, labels: routes }, { title: 'B', fg: null, labels: ['Buttons', 'Controls', 'Orders', 'Cart', 'Help', 'Map'] }), false);
  });
});

describe('baseLabel', () => {
  it('ignores live numbers and the similar-rows suffix', async () => {
    const { baseLabel } = await import('../src/utils/app-exploration.js');
    assert.equal(baseLabel('Current Memory Usage: 399091.0 MB'), baseLabel('Current Memory Usage: 401.5 MB'));
    assert.equal(baseLabel('Checking $1,000.00 (+3 similar rows)'), baseLabel('Checking $975.50'));
  });
});

describe('similarScreen without routes', () => {
  it('never matches two screens that have nothing to compare (a login screen and the home screen behind it)', async () => {
    const { similarScreen } = await import('../src/utils/app-exploration.js');
    assert.equal(similarScreen({ title: 'Bank', fg: null, labels: [] }, { title: 'Bank', fg: null, labels: [] }), false);
    assert.equal(similarScreen({ title: 'Bank', fg: null, labels: [] }, { title: 'Bank', fg: null, labels: ['Logout'] }), false);
  });
});

describe('distinctTitle', () => {
  it('tells screens with one title apart by their container name, else their first route, else a number', async () => {
    const { distinctTitle } = await import('../src/utils/app-exploration.js');
    const els = parseScreen('<AppiumAUT><XCUIElementTypeOther type="XCUIElementTypeOther" name="makePaymentView" enabled="true" visible="true" x="0" y="0" width="10" height="10"/></AppiumAUT>', 'ios');
    const taken = new Set(['SeeTestDemoApp']);
    assert.equal(distinctTitle(els, 'Home', taken), 'Home');
    assert.equal(distinctTitle(els, 'SeeTestDemoApp', taken), 'SeeTestDemoApp (makePaymentView)');
    assert.equal(distinctTitle([], 'SeeTestDemoApp', taken, 'Expense Report'), 'SeeTestDemoApp (Expense Report)');
    assert.equal(distinctTitle([], 'SeeTestDemoApp', taken), 'SeeTestDemoApp (2)');
  });
});

describe('similarScreen with named containers', () => {
  it('keeps screens with different container names apart', async () => {
    const { similarScreen } = await import('../src/utils/app-exploration.js');
    const routes = ['countryButton', 'cancelButton', 'sendButton'];
    assert.equal(similarScreen({ title: 'App', fg: null, labels: routes, container: 'makePaymentView' }, { title: 'App', fg: null, labels: routes, container: 'mortgageRequestView' }), false);
    assert.equal(similarScreen({ title: 'App', fg: null, labels: routes, container: 'makePaymentView' }, { title: 'App', fg: null, labels: routes, container: 'makePaymentView' }), true);
  });
});

describe('backControl: iOS back without ever tapping a destructive button', () => {
  const ios = (inner: string) => parseScreen(`<AppiumAUT>${inner}</AppiumAUT>`, 'ios');
  const btn = (name: string, x: number, nav = false) => `${nav ? '<XCUIElementTypeNavigationBar type="XCUIElementTypeNavigationBar" name="bar" enabled="true" visible="true" x="0" y="0" width="400" height="44">' : ''}<XCUIElementTypeButton type="XCUIElementTypeButton" name="${name}" label="${name}" enabled="true" visible="true" x="${x}" y="10" width="40" height="30"/>${nav ? '</XCUIElementTypeNavigationBar>' : ''}`;
  it('picks a back-labelled control, never Logout, and nothing when only a destructive button is there', async () => {
    const { backControl } = await import('../src/utils/app-exploration.js');
    assert.equal(backControl(ios(btn('logoutButton', 5, true) + btn('backButton', 300)))?.id, 'backButton');
    assert.equal(backControl(ios(btn('Logout', 5, true))), undefined);
    assert.equal(backControl(ios(btn('Cancel', 20) + btn('Back', 5, true)))?.id, 'Back');
  });
});

describe('safety words in ids and camelCase names', () => {
  it('treats logoutButton, btn_delete and an id-only sign-out as destructive, payButton as a write path', async () => {
    const { asWords } = await import('../src/utils/app-exploration.js');
    assert.equal(asWords('logoutButton'), 'logout Button');
    const el = (name: string) => parseScreen(`<AppiumAUT><XCUIElementTypeButton type="XCUIElementTypeButton" name="${name}" label="${name}" enabled="true" visible="true" x="0" y="0" width="40" height="30"/></AppiumAUT>`, 'ios')[0];
    assert.equal(classifyTap(el('logoutButton'), true).kind, 'destructive');
    assert.equal(classifyTap(el('btn_delete'), true).kind, 'destructive');
    assert.equal(classifyTap(el('signOutButton'), true).kind, 'destructive');
    assert.equal(classifyTap(el('makePaymentButton'), false).kind, 'unknown');
    assert.equal(classifyTap(el('payButton'), false).kind, 'action');
    const android = parseScreen('<hierarchy><android.widget.ImageButton class="android.widget.ImageButton" resource-id="com.acme:id/sign_out" bounds="[0,0][10,10]" clickable="true" enabled="true"/></hierarchy>', 'android')[0];
    assert.equal(classifyTap(android, true).kind, 'destructive');
  });
});

describe('apps already on the phone (Google Maps, Apple Maps)', () => {
  it('answers a system permission dialog with the most temporary choice, else a refusal, never a lasting grant', async () => {
    const { systemDialogAnswer } = await import('../src/utils/app-exploration.js');
    const dialog = (buttons: string[]) => parseScreen(`<hierarchy>${buttons.map((b, i) => `<android.widget.Button class="android.widget.Button" text="${b}" bounds="[0,${i * 100}][500,${i * 100 + 90}]" clickable="true" enabled="true"/>`).join('')}</hierarchy>`, 'android');
    const pkg = 'com.google.android.permissioncontroller';
    assert.equal(systemDialogAnswer(dialog(['While using the app', 'Only this time', 'Don’t allow']), pkg, 'android')?.answer, 'Only this time');
    assert.equal(systemDialogAnswer(dialog(['Allow', 'Don’t allow']), pkg, 'android')?.answer, 'Don’t allow');
    assert.equal(systemDialogAnswer(dialog(['Only this time']), 'com.acme.shop', 'android'), undefined, 'the app’s own screen is not a system dialog');
    const ios = parseScreen('<AppiumAUT><XCUIElementTypeAlert type="XCUIElementTypeAlert" name="Allow Maps to use your location?" enabled="true" visible="true" x="0" y="0" width="300" height="200"><XCUIElementTypeButton type="XCUIElementTypeButton" name="Allow Once" label="Allow Once" enabled="true" visible="true" x="0" y="100" width="300" height="40"/><XCUIElementTypeButton type="XCUIElementTypeButton" name="Allow While Using App" label="Allow While Using App" enabled="true" visible="true" x="0" y="140" width="300" height="40"/></XCUIElementTypeAlert></AppiumAUT>', 'ios');
    assert.equal(systemDialogAnswer(ios, 'com.apple.Maps', 'ios')?.answer, 'Allow Once');
  });

  it('reads the installed version from dumpsys', async () => {
    const { versionFromDumpsys } = await import('../src/utils/app-exploration.js');
    assert.equal(versionFromDumpsys('  Package [com.google.android.apps.maps]\n    versionCode=1062 minSdk=28\n    versionName=26.47.03.123 (build)\n'), '26.47.03.123');
    assert.equal(versionFromDumpsys(''), undefined);
  });
});

describe('start_app_exploration installedApp', () => {
  it('needs a package or bundle id, not a repository id', async () => {
    const stub = await startStubApi(() => undefined);
    const t = await connectTools(registerExplorationTools);
    try {
      let r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android', installedApp: true, appId: 7 });
      assert.match(r.text, /NOT in the repository/);
      r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android', installedApp: true });
      assert.match(r.text, /installedApp needs packageName/);
      r = await t.call('start_app_exploration', { allowWritePaths: false, platform: 'android', installedApp: true, packageName: 'com.google.android.apps.maps', outputFormat: 'json' });
      assert.notEqual(r.res.isError, true, r.text);
    } finally { await t.close(); await stub.close(); }
  });
});

describe('bottom navigation drawn with plain views', () => {
  it('a row of labelled controls at the bottom is navigation, so read-only crawls follow it', () => {
    const els = parseScreen(`<hierarchy><android.widget.FrameLayout class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" clickable="false" enabled="true">
      <android.widget.Button class="android.widget.Button" text="Search here" bounds="[0,1000][1080,1100]" clickable="true" enabled="true"/>
      <android.widget.FrameLayout class="android.widget.FrameLayout" content-desc="You" resource-id="com.google.android.apps.maps:id/saved_tab_strip_button" bounds="[360,2105][720,2274]" clickable="true" enabled="true"/>
      <android.widget.FrameLayout class="android.widget.FrameLayout" content-desc="Contribute" resource-id="com.google.android.apps.maps:id/contribute_tab_strip_button" bounds="[720,2105][1080,2274]" clickable="true" enabled="true"/>
    </android.widget.FrameLayout></hierarchy>`, 'android');
    const you = els.find((e) => e.description === 'You')!;
    assert.equal(you.inNavigation, 'tabs');
    assert.equal(classifyTap(you, false).kind, 'navigation');
    assert.equal(els.find((e) => e.text === 'Search here')!.inNavigation, null);
  });
});

describe('prompts at start', () => {
  it('dismissing a promo or permission prompt is navigation; Continue is not', () => {
    const b = (t: string) => parseScreen(`<hierarchy><android.widget.Button class="android.widget.Button" text="${t}" bounds="[0,500][500,600]" clickable="true" enabled="true"/></hierarchy>`, 'android')[0];
    for (const t of ['Got it', 'Not now', 'No thanks', 'Skip', 'Dismiss']) assert.equal(classifyTap(b(t), false).kind, 'navigation', t);
    assert.notEqual(classifyTap(b('OK'), false).kind, 'navigation', 'OK can accept a notice or terms');
    assert.notEqual(classifyTap(b('Continue'), false).kind, 'navigation');
  });
});

describe('action rows are not tab bars', () => {
  it('two buttons at the bottom of a sheet (Start, Add stops) are not tabs; a full-width bar of three is', () => {
    const screen = (inner: string) => parseScreen(`<hierarchy><android.widget.FrameLayout class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" clickable="false" enabled="true">${inner}</android.widget.FrameLayout></hierarchy>`, 'android');
    const btn = (t: string, x1: number, x2: number, y1: number, y2: number) => `<android.widget.Button class="android.widget.Button" text="${t}" bounds="[${x1},${y1}][${x2},${y2}]" clickable="true" enabled="true"/>`;
    const sheet = screen(btn('Start', 40, 400, 2000, 2120) + btn('Add stops', 420, 800, 2000, 2120));
    assert.equal(sheet.find((e) => e.text === 'Start')!.inNavigation, null);
    const bar = screen(btn('Home', 0, 360, 2260, 2400) + btn('Search', 360, 720, 2260, 2400) + btn('Library', 720, 1080, 2260, 2400));
    assert.equal(bar.find((e) => e.text === 'Search')!.inNavigation, 'tabs');
  });
});

describe('crash dialogs', () => {
  it('recognises Android crash and not-responding dialogs, not ordinary text', async () => {
    const { crashDialog } = await import('../src/utils/app-exploration.js');
    const t = (s: string) => parseScreen(`<hierarchy><android.widget.TextView class="android.widget.TextView" text="${s}" bounds="[0,0][500,90]" clickable="false" enabled="true"/></hierarchy>`, 'android');
    assert.equal(crashDialog(t('Maps keeps stopping')), 'Maps keeps stopping');
    assert.equal(crashDialog(t('Bank isn’t responding')), 'Bank isn’t responding');
    assert.equal(crashDialog(t('Your transfer has stopped at the limit for today')), undefined);
    assert.equal(crashDialog(t('Welcome')), undefined);
  });
});
