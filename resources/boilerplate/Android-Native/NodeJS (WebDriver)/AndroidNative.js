describe('LocalAndroidTest', () => {
    it('quickStartAndroidNativeDemo', myTest)
 })
 // Explicit wait: resolve the element and wait until it is displayed (waitforTimeout in wdio.conf.js) before acting.
 async function find(selector) {
   const el = await $(selector);
   await el.waitForDisplayed();
   return el;
 }
 async function myTest() {
   // [BEGIN_DEMO_STEPS]
   const username = await find('id=com.experitest.ExperiBank:id/usernameTextField');
   await username.setValue('company');
   const password = await find('id=com.experitest.ExperiBank:id/passwordTextField');
   await password.setValue('company');
   const loginButton = await find('id=com.experitest.ExperiBank:id/loginButton');
   await loginButton.click();
   const makePaymentButton = await find('id=com.experitest.ExperiBank:id/makePaymentButton');
   await makePaymentButton.click();
   const phoneNumber = await find('id=com.experitest.ExperiBank:id/phoneTextField');
   await phoneNumber.setValue('0541234567');
   const name = await find('id=com.experitest.ExperiBank:id/nameTextField');
   await name.setValue('Jon Snow');
   const amount = await find('id=com.experitest.ExperiBank:id/amountTextField');
   await amount.setValue('50');
   const countryButton = await find('id=com.experitest.ExperiBank:id/countryButton');
   await countryButton.click();
   const country = await find('//*[@text="Switzerland"]');
   await country.click();
   const sendPaymentButton = await find('id=com.experitest.ExperiBank:id/sendPaymentButton');
   await sendPaymentButton.click();
   const yesButton = await find('id=android:id/button1');
   await yesButton.click();
   // [END_DEMO_STEPS]
 }
 