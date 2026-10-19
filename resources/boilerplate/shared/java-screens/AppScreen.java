import io.appium.java_client.AppiumBy;
import io.appium.java_client.AppiumDriver;
import org.openqa.selenium.By;

/**
 * ⛔ PLACEHOLDER SCREEN — the locators below are NOT real. Replace every <…> with a value captured from a live
 * inspection (start_inspection_session -> get_element_tree / find_elements, or open_mobile_studio), rename the class to
 * the screen it represents, and add one such class per screen. NEVER guess a resource-id or accessibility id.
 */
public class AppScreen extends BaseScreen {
    private final By primaryField = platform(By.id("<resource-id from get_element_tree>"), AppiumBy.accessibilityId("<accessibility id from get_element_tree>"));
    private final By primaryButton = platform(By.id("<resource-id>"), AppiumBy.accessibilityId("<accessibility id>"));

    public AppScreen(AppiumDriver driver) {
        super(driver);
    }

    public AppScreen enterValue(String value) {
        type(primaryField, value);
        return this;
    }

    public AppScreen tapPrimaryButton() {
        tap(primaryButton);
        return this;
    }
}
