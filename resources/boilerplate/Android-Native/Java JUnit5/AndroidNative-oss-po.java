import io.appium.java_client.android.AndroidDriver;
import io.appium.java_client.android.options.UiAutomator2Options;
import org.junit.jupiter.api.*;

import screens.*;

import java.net.MalformedURLException;
import java.net.URI;

/** Page-object layout: the screens live in the screens package (BaseScreen + one class per screen); the test reads as the flow. */
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
        driver = new AndroidDriver(URI.create("[Enter Instance here]/wd/hub").toURL(), options);
    }

    @Test
    public void quickStartAndroidNativeDemo() {
        // [BEGIN_DEMO_STEPS]
        new LoginScreen(driver).login("company", "company")
            .makePayment()
            .fillPayment("0501234567", "John Snow", "50", "Switzerland")
            .sendAndConfirm();
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
