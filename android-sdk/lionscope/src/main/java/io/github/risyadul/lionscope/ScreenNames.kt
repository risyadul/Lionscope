package io.github.risyadul.lionscope

import java.lang.reflect.Method
import java.lang.reflect.Modifier

/**
 * Screen display names. Honours a common screen-alias convention: a public zero-arg
 * `getScreen()` returning an object whose `getValue()` is a non-blank String; otherwise the simple class name.
 */
internal object ScreenNames {
    private val screenGetters = HashMap<Class<*>, Method?>()
    private val valueGetters = HashMap<Class<*>, Method?>()

    fun nameOf(target: Any): String =
        aliasOf(target) ?: target.javaClass.simpleName.ifEmpty { target.javaClass.name.substringAfterLast('.') }

    @Synchronized
    fun aliasOf(target: Any): String? = try {
        val screen = getter(screenGetters, target.javaClass, "getScreen")?.invoke(target)
        val value = screen?.let { getter(valueGetters, it.javaClass, "getValue")?.invoke(it) }
        (value as? String)?.takeIf { it.isNotBlank() }
    } catch (e: Exception) {
        null
    } catch (e: LinkageError) {
        null
    }

    private fun getter(cache: HashMap<Class<*>, Method?>, type: Class<*>, name: String): Method? {
        if (cache.containsKey(type)) return cache[type]
        val method = lookup(type, name)
        cache[type] = method
        return method
    }

    private fun lookup(type: Class<*>, name: String): Method? = try {
        type.getMethod(name).takeIf { !Modifier.isStatic(it.modifiers) && it.returnType != Void.TYPE }?.also {
            // Public method on a non-public class (e.g. a private enum) still needs this to be invocable.
            try {
                it.isAccessible = true
            } catch (e: SecurityException) {
                // Keep the method; invoke() may still succeed.
            }
        }
    } catch (e: NoSuchMethodException) {
        null
    } catch (e: SecurityException) {
        null
    } catch (e: LinkageError) {
        null
    }
}
