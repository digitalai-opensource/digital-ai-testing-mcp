describe('LocaliOSTest', () => {
    it('[testNameHere]', myTest)
 })
 async function myTest() {
   // [BEGIN_DEMO_STEPS]
   const username = await $('//*[@name="usernameTextField"]');
   await username.setValue('company');
   const password = await $('//*[@name="passwordTextField"]');
   await password.setValue('company');
   const loginButton = await $('//*[@name="loginButton"]');
   await loginButton.click();
   const makePaymentButton = await $('//*[@name="makePaymentButton"]');
   await makePaymentButton.click();
   const phoneNumber = await $("//*[@name='phoneTextField']");
   await phoneNumber.setValue('0541234567');
   const name = await $("//*[@name='nameTextField']");
   await name.setValue('Jon Snow');
   const amount = await $("//*[@name='amountTextField']");
   await amount.setValue('50');
   const countryButton = await $("//*[@name='countryButton']");
   await countryButton.click();
   const country = await $("//*[@name='Switzerland']");
   await country.click();
   const sendPaymentButton = await $("//*[@name='sendPaymentButton']");
   await sendPaymentButton.click();
   const yesButton = await $("//*[@name='Yes']");
   await yesButton.click();
   // [END_DEMO_STEPS]
 }
 