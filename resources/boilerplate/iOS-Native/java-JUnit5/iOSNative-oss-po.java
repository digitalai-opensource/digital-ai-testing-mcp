import io.appium.java_client.ios.IOSDriver;
import io.appium.java_client.ios.options.XCUITestOptions;
import org.junit.jupiter.api.*;

import java.net.MalformedURLException;
import java.net.URI;

/** Page-object layout: screens live next to this class (BaseScreen + one class per screen); the test reads as the flow. */
public class LocaliOSTest {

    private IOSDriver driver;

    @BeforeEach
    public void setUp() throws MalformedURLException {
        XCUITestOptions options = new XCUITestOptions();
        options.setCapability("digitalai:testName", "[Enter Test Name here]");
        options.setCapability("digitalai:accessKey", "[Enter Your Access key here]");
        options.setCapability("digitalai:deviceQuery", "@os='ios' and @category='[Enter PHONE/TABLET here]'");
        options.setApp("cloud:com.experitest.ExperiBank");
        options.setBundleId("com.experitest.ExperiBank");
        driver = new IOSDriver(URI.create("[Enter Instance here]/wd/hub").toURL(), options);
    }

    @Test
    public void quickStartiOSNativeDemo() {
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
