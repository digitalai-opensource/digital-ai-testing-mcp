import io.appium.java_client.AppiumDriver;
import org.openqa.selenium.By;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;

import java.time.Duration;

/**
 * One class per screen. Every interaction waits explicitly for its element (no implicit wait anywhere), and each
 * locator is chosen per platform at runtime, so one screen class serves the Android and the iOS build of the app.
 * Screens return the next screen, so a test reads as the user flow: new LoginScreen(driver).login(..).makePayment()..
 */
public abstract class BaseScreen {
    protected final AppiumDriver driver;
    protected final boolean android;

    protected BaseScreen(AppiumDriver driver) {
        this.driver = driver;
        this.android = "android".equalsIgnoreCase(String.valueOf(driver.getCapabilities().getPlatformName()));
    }

    /** Pick the locator for the platform this session runs on. */
    protected By platform(By androidLocator, By iosLocator) {
        return android ? androidLocator : iosLocator;
    }

    /** Explicit wait (20 s) until the element is visible, then return it. Never mix with an implicit wait. */
    protected WebElement find(By by) {
        return new WebDriverWait(driver, Duration.ofSeconds(20)).until(ExpectedConditions.visibilityOfElementLocated(by));
    }

    protected void tap(By by) {
        find(by).click();
    }

    protected void type(By by, String text) {
        find(by).sendKeys(text);
    }
}
