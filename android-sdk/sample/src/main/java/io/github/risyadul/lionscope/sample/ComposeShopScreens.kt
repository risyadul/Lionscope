package io.github.risyadul.lionscope.sample

import android.widget.RatingBar
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

/**
 * A realistic list screen for the Compose Inspector: a header, then cards of a few composables each, under an idle
 * [ToastHost].
 */
@Composable
fun CatalogScreen(onProduct: (Int) -> Unit, onLogin: () -> Unit, onPromo: () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        Surface(Modifier.fillMaxSize()) {
            LazyColumn(Modifier.testTag("catalog"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                item {
                    Column(Modifier.padding(16.dp)) {
                        Text("Compose shop", style = MaterialTheme.typography.headlineSmall)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = onLogin) { Text("Sign in") }
                            OutlinedButton(onClick = onPromo) { Text("Promo") }
                        }
                    }
                }
                items(PRODUCTS) { product -> ProductCard(product, onClick = { onProduct(product.id) }) }
            }
        }
        ToastHost()
    }
}

/**
 * Where an app would show its toasts, idle: a full-size Box drawn over the whole screen that paints nothing. Picking
 * on the screen in the Inspector looks through it to the catalog below (it stays in the tree).
 */
@Composable
fun ToastHost() {
    Box(Modifier.fillMaxSize().padding(bottom = 32.dp))
}

@Composable
fun ProductCard(product: Product, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(product.name, style = MaterialTheme.typography.titleMedium)
                Text(product.price, style = MaterialTheme.typography.bodyMedium)
            }
            Button(onClick = onClick, modifier = Modifier.testTag("open_${product.id}")) { Text("View") }
        }
    }
}

/** An AndroidView inside Compose: a classic RatingBar, so the Inspector shows a View under a composable. */
@Composable
fun ProductScreen(id: Int, onBack: () -> Unit) {
    val product = PRODUCTS.firstOrNull { it.id == id } ?: PRODUCTS.first()
    var gift by remember { mutableStateOf(false) }
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(product.name, style = MaterialTheme.typography.headlineSmall)
            Text(product.price, Modifier.semantics { contentDescription = "Price" })
            AndroidView(factory = { context -> RatingBar(context).apply { rating = 4f } })
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = gift, onCheckedChange = { gift = it })
                Text("Gift wrap")
            }
            Row {
                Button(onClick = onBack) { Text("Add to cart") }
                Spacer(Modifier.width(8.dp))
                TextButton(onClick = onBack) { Text("Back") }
            }
        }
    }
}

/** The password field must never reach the Inspector (its value, nor any text of it). */
@Composable
fun LoginScreen(onDone: () -> Unit) {
    var email by remember { mutableStateOf("shopper@example.com") }
    var password by remember { mutableStateOf("hunter2-secret") }
    var pin by remember { mutableStateOf("4321") }
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Sign in", style = MaterialTheme.typography.headlineSmall)
            OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text("Email") })
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Password") },
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.testTag("password"),
            )
            OutlinedTextField(
                value = pin,
                onValueChange = { pin = it },
                label = { Text("PIN") },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            )
            Button(onClick = onDone) { Text("Continue") }
        }
    }
}

@Composable
fun PromoDialog(onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Promo") },
        text = { Text("A dialog destination: its own window, its own screen.") },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Nice") } },
    )
}

/** A Compose card inside the XML More screen (ComposeView in a Fragment). */
@Composable
fun ComposeNoteCard(onOpenShop: () -> Unit) {
    MaterialTheme {
        Card(Modifier.fillMaxWidth().padding(top = 16.dp)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("This card is Compose inside an XML layout (ComposeView).")
                Button(onClick = onOpenShop) { Text("Open Compose shop") }
            }
        }
    }
}

class Product(val id: Int, val name: String, val price: String)

val PRODUCTS: List<Product> = List(30) { index -> Product(index + 1, "Product ${index + 1}", "$${(index + 1) * 3}.99") }
