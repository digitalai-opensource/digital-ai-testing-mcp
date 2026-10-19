const AppScreen = require('./AppScreen');
const DashboardScreen = require('./DashboardScreen');

class LoginScreen extends AppScreen {
    // Android: resource-id ("id=…"). iOS: accessibility id ("~…" = the element's name — identifier, else label).
    get username() { return this.platform('id=com.experitest.ExperiBank:id/usernameTextField', '~usernameTextField'); }
    get password() { return this.platform('id=com.experitest.ExperiBank:id/passwordTextField', '~passwordTextField'); }
    get loginButton() { return this.platform('id=com.experitest.ExperiBank:id/loginButton', '~loginButton'); }

    async login(user, pass) {
        await this.type(this.username, user);
        await this.type(this.password, pass);
        await this.tap(this.loginButton);
        return new DashboardScreen();
    }
}

module.exports = LoginScreen;
