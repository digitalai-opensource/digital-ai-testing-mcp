import io.appium.java_client.ios.IOSDriver;
import io.appium.java_client.ios.options.XCUITestOptions;
import org.testng.annotations.*;
import io.appium.java_client.AppiumBy;
import org.openqa.selenium.By;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;

import java.net.MalformedURLException;
import java.net.URI;
import java.time.Duration;

public class LocaliOSTest {

    private IOSDriver driver;

    @BeforeMethod
    public void setUp() throws MalformedURLException {
        XCUITestOptions options = new XCUITestOptions();
        options.setCapability("digitalai:testName", "[Enter Test Name here]");
        options.setCapability("digitalai:accessKey", "[Enter Your Access key here]");
        options.setCapability("digitalai:deviceQuery", "@os='ios' and @category='[Enter PHONE/TABLET here]'");
        options.setApp("cloud:com.experitest.ExperiBank");
        options.setBundleId("com.experitest.ExperiBank");
        driver = new IOSDriver(URI.create("[Enter Instance here]/wd/hub").toURL(), options);
    }

    // Explicit wait: polls until the element is visible (20 s), then returns it. Used instead of an implicit wait —
    // never mix the two (every miss then waits implicit + explicit, and the real timeout becomes unpredictable).
    private WebElement find(By by) {
        return new WebDriverWait(driver, Duration.ofSeconds(20)).until(ExpectedConditions.visibilityOfElementLocated(by));
    }

    @Test
    public void quickStartiOSNativeDemo() {
        // [BEGIN_DEMO_STEPS]
        find(AppiumBy.accessibilityId("usernameTextField")).sendKeys("company");
        find(AppiumBy.accessibilityId("passwordTextField")).sendKeys("company");
        find(AppiumBy.accessibilityId("loginButton")).click();
        find(AppiumBy.accessibilityId("makePaymentButton")).click();
        find(AppiumBy.accessibilityId("phoneTextField")).sendKeys("0501234567");
        find(AppiumBy.accessibilityId("nameTextField")).sendKeys("John Snow");
        find(AppiumBy.accessibilityId("amountTextField")).sendKeys("50");
        find(AppiumBy.accessibilityId("countryButton")).click();
        find(AppiumBy.accessibilityId("Switzerland")).click();
        find(AppiumBy.accessibilityId("sendPaymentButton")).click();
        find(AppiumBy.accessibilityId("Yes")).click();
        // [END_DEMO_STEPS]
    }

    @AfterMethod
    public void tearDown() {
        if (driver == null) return;
        try {
            System.out.println("Report URL: " + driver.getCapabilities().getCapability("digitalai:reportUrl"));
            System.out.println("Report Test ID: " + driver.getCapabilities().getCapability("digitalai:reportTestId"));
        } catch (Exception ignored) {}
        try {
            driver.quit();
        } catch (Exception ignored) {}
    }
}
