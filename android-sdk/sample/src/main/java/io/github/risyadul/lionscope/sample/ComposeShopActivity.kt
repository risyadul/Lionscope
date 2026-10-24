package io.github.risyadul.lionscope.sample

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.dialog
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import io.github.risyadul.lionscope.Lionscope

/**
 * A pure-Compose screen stack: one ComponentActivity, navigation-compose destinations. Lionscope reports each
 * destination's route pattern as the screen (`product/{id}`, never the id) once the NavController is tracked.
 */
class ComposeShopActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                val navController = rememberNavController()
                Lionscope.trackNavigation(navController)
                NavHost(navController, startDestination = Routes.CATALOG) {
                    composable(Routes.CATALOG) {
                        CatalogScreen(
                            onProduct = { id -> navController.navigate("product/$id") },
                            onLogin = { navController.navigate(Routes.LOGIN) },
                            onPromo = { navController.navigate(Routes.PROMO) },
                        )
                    }
                    composable(Routes.PRODUCT, arguments = listOf(navArgument("id") { type = NavType.IntType })) { entry ->
                        ProductScreen(id = entry.arguments?.getInt("id") ?: 0, onBack = { navController.popBackStack() })
                    }
                    composable(Routes.LOGIN) { LoginScreen(onDone = { navController.popBackStack() }) }
                    dialog(Routes.PROMO) { PromoDialog(onDismiss = { navController.popBackStack() }) }
                }
            }
        }
    }

    object Routes {
        const val CATALOG = "catalog"
        const val PRODUCT = "product/{id}"
        const val LOGIN = "login"
        const val PROMO = "promo"
    }
}
