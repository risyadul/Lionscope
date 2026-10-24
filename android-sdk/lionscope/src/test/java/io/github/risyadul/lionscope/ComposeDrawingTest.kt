package io.github.risyadul.lionscope

import androidx.compose.foundation.IndicationInstance
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.paint
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorProducer
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.painter.ColorPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.LayoutInfo
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Proxy

/**
 * [ComposeDrawing] on real layout nodes and the modifier nodes Compose (1.6.8, the oldest read) creates for them; the
 * library classes the composables use internally (Text's, the clickable's) are built by reflection.
 */
class ComposeDrawingTest {
    private val drawing = ComposeDrawing()

    private fun layout(modifier: Modifier): LayoutInfo {
        val type = Class.forName("androidx.compose.ui.node.LayoutNode")
        val node = type.getConstructor().newInstance()
        type.getMethod("setModifier", Modifier::class.java).invoke(node, modifier)
        return node as LayoutInfo
    }

    private fun draws(vararg modifiers: Modifier): Boolean? = drawing.of(modifiers.map(::layout))

    /** What `Text("Checkout")` puts on its layout node. */
    private fun Modifier.text(): Modifier {
        val type = Class.forName("androidx.compose.foundation.text.modifiers.TextStringSimpleElement")
        val resolver = Proxy.newProxyInstance(type.classLoader, arrayOf(FontFamily.Resolver::class.java)) { _, _, _ -> null }
        val constructor = type.declaredConstructors.single { it.parameterCount == 9 }
        return then(constructor.newInstance("Checkout", TextStyle.Default, resolver, 1, true, Int.MAX_VALUE, 1, null as ColorProducer?, null) as Modifier)
    }

    /** What `Image(painter, "Logo")` puts on its layout node. */
    private fun Modifier.image(): Modifier = this
        .semantics {
            contentDescription = "Logo"
            role = Role.Image
        }
        .clipToBounds()
        .paint(ColorPainter(Color.Red), contentScale = ContentScale.Fit)

    /** `Modifier.clickable(interactionSource, indication = null)`'s own node (its semantics and pointer input). */
    private fun Modifier.clickable(): Modifier {
        val type = Class.forName("androidx.compose.foundation.ClickableElement")
        val constructor = type.declaredConstructors.single { it.parameterCount == 6 }.apply { isAccessible = true }
        return then(constructor.newInstance(MutableInteractionSource(), true, null, null, {}, null) as Modifier)
    }

    /** The pre-node element `Modifier.indication` adds for an Indication that is not a node factory. */
    private fun Modifier.indication(): Modifier {
        val type = Class.forName("androidx.compose.foundation.IndicationModifier")
        val instance = object : IndicationInstance {
            override fun ContentDrawScope.drawIndication() = drawContent()
        }
        return then(type.declaredConstructors.single().apply { isAccessible = true }.newInstance(instance) as Modifier)
    }

    @Test
    fun aFullSizeBoxWithOnlySizePaddingAndSemanticsPaintsNothing() {
        assertEquals(false, draws(Modifier.fillMaxSize()))
        assertEquals(false, draws(Modifier.fillMaxSize().padding(16.dp).testTag("toastHost").semantics { contentDescription = "x" }))
        assertEquals(false, draws(Modifier))
    }

    @Test
    fun aClickableBoxPaintsNothingAndItsIndicationIsNotCounted() {
        assertEquals(false, draws(Modifier.size(48.dp).clickable()))
        assertEquals(false, draws(Modifier.size(48.dp).indication().clickable()))
    }

    @Test
    fun backgroundsBordersAndDrawModifiersPaint() {
        assertEquals(true, draws(Modifier.fillMaxSize().background(Color.Black)))
        // BorderModifierNode draws through a delegate.
        assertEquals(true, draws(Modifier.padding(4.dp).border(1.dp, Color.Black)))
        assertEquals(true, draws(Modifier.drawBehind { }))
        assertEquals(true, draws(Modifier.drawWithContent { drawContent() }))
        assertEquals(true, draws(Modifier.drawWithCache { onDrawBehind { } }))
    }

    @Test
    fun textAndImagesPaint() {
        assertEquals(true, draws(Modifier.text()))
        assertEquals(true, draws(Modifier.image()))
    }

    @Test
    fun aGraphicsLayerPaintsOnlyAShadow() {
        assertEquals(false, draws(Modifier.alpha(0.5f)))
        assertEquals(false, draws(Modifier.graphicsLayer(scaleX = 2f)))
        assertEquals(true, draws(Modifier.graphicsLayer(shadowElevation = 8f)))
        assertNull(draws(Modifier.graphicsLayer { alpha = 0.5f })) // Set by a lambda: unknown.
        assertEquals(true, draws(Modifier.graphicsLayer { alpha = 0.5f }.background(Color.Black)))
    }

    @Test
    fun aContainerWhoseDrawingIsInItsChildrenPaintsNothing() {
        val container = layout(Modifier.fillMaxSize().padding(8.dp))
        val child = layout(Modifier.background(Color.Black))
        val insert = container.javaClass.declaredMethods.single { it.name.startsWith("insertAt$") }
        insert.invoke(container, 0, child)
        assertTrue(container.childrenInfo().isNotEmpty())
        assertEquals(false, drawing.of(listOf(container)))
        assertEquals(true, drawing.of(listOf(container, child)))
    }

    @Test
    fun anythingUnreadableIsUnknown() {
        assertNull(drawing.of(listOf(Any())))
        assertNull(drawing.of(listOf(layout(Modifier.fillMaxSize()), "not a layout node")))
        // A paint found first still answers.
        assertEquals(true, drawing.of(listOf(layout(Modifier.background(Color.Black)), Any())))
        assertFalse(drawing.of(emptyList()) ?: true)
    }

    private fun LayoutInfo.childrenInfo(): List<*> =
        javaClass.declaredMethods.single { it.name.startsWith("getChildren$") && it.parameterCount == 0 }.invoke(this) as List<*>
}
