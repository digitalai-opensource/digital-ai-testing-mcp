package screens;

import io.appium.java_client.AppiumBy;
import io.appium.java_client.AppiumDriver;
import org.openqa.selenium.By;

public class LoginScreen extends BaseScreen {
    // Android: resource-id. iOS: accessibility id (= the element's name — identifier, else label).
    private final By username = platform(By.id("com.experitest.ExperiBank:id/usernameTextField"), AppiumBy.accessibilityId("usernameTextField"));
    private final By password = platform(By.id("com.experitest.ExperiBank:id/passwordTextField"), AppiumBy.accessibilityId("passwordTextField"));
    private final By loginButton = platform(By.id("com.experitest.ExperiBank:id/loginButton"), AppiumBy.accessibilityId("loginButton"));

    public LoginScreen(AppiumDriver driver) {
        super(driver);
    }

    public DashboardScreen login(String user, String pass) {
        type(username, user);
        type(password, pass);
        tap(loginButton);
        return new DashboardScreen(driver);
    }
}
