import io.appium.java_client.android.AndroidDriver;
import io.appium.java_client.android.options.UiAutomator2Options;
import org.junit.jupiter.api.*;
import org.openqa.selenium.By;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;

import java.net.MalformedURLException;
import java.net.URI;
import java.time.Duration;

public class LocalAndroidTest {

    private AndroidDriver driver;

    @BeforeEach
    public void setUp() throws MalformedURLException {
        UiAutomator2Options options = new UiAutomator2Options();
        options.setCapability("digitalai:testName", "[Enter Test Name here]");
        options.setCapability("digitalai:accessKey", "[Enter Your Access key here]");
        options.setCapability("digitalai:deviceQuery", "@os='android' and @category='[Enter PHONE/TABLET here]'");
        options.setApp("cloud:com.experitest.ExperiBank/.LoginActivity");
        options.setAppPackage("com.experitest.ExperiBank");
        options.setAppActivity(".LoginActivity");
        options.setCapability("autoDismissAlerts", true);
        options.setCapability("autoGrantPermissions", true);
        // System-level overlays (charging dialog, USB prompt) are NOT caught by autoDismissAlerts.
        // If they block tests, call after driver init:
        //   driver.executeScript("mobile: shell", Map.of("command","am","args",List.of("broadcast","-a","android.intent.action.CLOSE_SYSTEM_DIALOGS")));
        driver = new AndroidDriver(URI.create("[Enter Instance here]/wd/hub").toURL(), options);
    }

    // Explicit wait: polls until the element is visible (20 s), then returns it. Used instead of an implicit wait —
    // never mix the two (every miss then waits implicit + explicit, and the real timeout becomes unpredictable).
    private WebElement find(By by) {
        return new WebDriverWait(driver, Duration.ofSeconds(20)).until(ExpectedConditions.visibilityOfElementLocated(by));
    }

    @Test
    public void quickStartAndroidNativeDemo() {
        // [BEGIN_DEMO_STEPS]
        find(By.id("com.experitest.ExperiBank:id/usernameTextField")).sendKeys("company");
        find(By.id("com.experitest.ExperiBank:id/passwordTextField")).sendKeys("company");
        find(By.id("com.experitest.ExperiBank:id/loginButton")).click();
        find(By.id("com.experitest.ExperiBank:id/makePaymentButton")).click();
        find(By.id("com.experitest.ExperiBank:id/phoneTextField")).sendKeys("0501234567");
        find(By.id("com.experitest.ExperiBank:id/nameTextField")).sendKeys("John Snow");
        find(By.id("com.experitest.ExperiBank:id/amountTextField")).sendKeys("50");
        find(By.id("com.experitest.ExperiBank:id/countryButton")).click();
        find(By.xpath("//*[@text='Switzerland']")).click();
        find(By.id("com.experitest.ExperiBank:id/sendPaymentButton")).click();
        find(By.id("android:id/button1")).click();
        // [END_DEMO_STEPS]
    }

    @AfterEach
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
