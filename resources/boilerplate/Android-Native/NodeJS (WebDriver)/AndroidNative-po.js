const LoginScreen = require('../screenobjects/LoginScreen');

describe('LocalAndroidTest', () => {
    it('quickStartAndroidNativeDemo', myTest)
 })
 async function myTest() {
   // [BEGIN_DEMO_STEPS]
   const dashboard = await new LoginScreen().login('company', 'company');
   const payment = await dashboard.makePayment();
   await payment.fillPayment('0541234567', 'Jon Snow', '50', 'Switzerland');
   await payment.sendAndConfirm();
   // [END_DEMO_STEPS]
 }
