describe('LocaliOSTest', () => {
    it('[testNameHere]', myTest)
 })
 // Explicit wait: resolve the element and wait until it is displayed (waitforTimeout in wdio.conf.js) before acting.
 async function find(selector) {
   const el = await $(selector);
   await el.waitForDisplayed();
   return el;
 }
 async function myTest() {
   // [BEGIN_DEMO_STEPS]
   const username = await find('~usernameTextField');
   await username.setValue('company');
   const password = await find('~passwordTextField');
   await password.setValue('company');
   const loginButton = await find('~loginButton');
   await loginButton.click();
   const makePaymentButton = await find('~makePaymentButton');
   await makePaymentButton.click();
   const phoneNumber = await find('~phoneTextField');
   await phoneNumber.setValue('0541234567');
   const name = await find('~nameTextField');
   await name.setValue('Jon Snow');
   const amount = await find('~amountTextField');
   await amount.setValue('50');
   const countryButton = await find('~countryButton');
   await countryButton.click();
   const country = await find('~Switzerland');
   await country.click();
   const sendPaymentButton = await find('~sendPaymentButton');
   await sendPaymentButton.click();
   const yesButton = await find('~Yes');
   await yesButton.click();
   // [END_DEMO_STEPS]
 }
 