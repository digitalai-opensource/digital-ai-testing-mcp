import { describe, it, assert } from 'vitest';
import { parseScreen, screenSignature, classifyTap, isLoading, candidateTaps, locatorFor } from '../src/utils/app-exploration.js';

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
    assert.equal(classifyTap(byId(login, 'org.example.bank:id/signin')).kind, 'unknown', 'a sign-in button is not navigation: it needs the user');
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
import { startStubApi, connectTools, type StubApi, type ToolClient } from './helpers/offline.js';
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
