const AppScreen = require('./AppScreen');
const PaymentScreen = require('./PaymentScreen');

class DashboardScreen extends AppScreen {
    get makePaymentButton() { return this.platform('id=com.experitest.ExperiBank:id/makePaymentButton', '~makePaymentButton'); }

    async makePayment() {
        await this.tap(this.makePaymentButton);
        return new PaymentScreen();
    }
}

module.exports = DashboardScreen;
