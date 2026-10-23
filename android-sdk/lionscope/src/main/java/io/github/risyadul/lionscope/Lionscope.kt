package io.github.risyadul.lionscope

import android.content.Context
import androidx.navigation.NavController
import okhttp3.Interceptor

/**
 * Lionscope in-app SDK (debug artifact).
 *
 * Installed automatically through androidx.startup in debuggable builds; there is nothing to call. Hosts that
 * remove `androidx.startup.InitializationProvider` from their merged manifest can call [install] from
 * `Application.onCreate` instead. Release builds should depend on `lionscope-noop`, which has the same API.
 *
 * Data flow: the SDK connects to `127.0.0.1:8700` on the device, which `adb reverse` forwards to the Lionscope
 * server on the laptop. Without that reverse mapping, any other app on the device listening on
 * 127.0.0.1:8700 would receive the stream (screen class names, frame timings and, while a v2 server asks for
 * them, main-thread stack traces of stalls / StrictMode violations; debug builds only).
 */
object Lionscope {
    /** SDK version (the Gradle build version), reported to the Lionscope server in `hello`. */
    const val VERSION = LionscopeBuild.VERSION

    @Volatile
    internal var installed = false

    /** True once the SDK has been installed in this process (debuggable app, main process). */
    fun isActive(): Boolean = installed

    /**
     * Installs the SDK manually. Idempotent; does nothing unless the app is debuggable and this is its main
     * process. Never throws.
     */
    fun install(context: Context) {
        LionscopeRuntime.installIfEligible(context)
    }

    /**
     * Reports [navController]'s destinations as screens: the route pattern (`product/{id}`, never argument values;
     * a type-safe route by its class name) becomes the screen name while that destination is shown in its Activity
     * and no app Fragment is on top. Safe to call from composition on every recomposition (idempotent per
     * controller) and from any thread; does nothing in release builds (`lionscope-noop`) or before the SDK is
     * installed. Nested NavHosts: track each; the innermost shown destination wins.
     */
    fun trackNavigation(navController: NavController) {
        LionscopeRuntime.trackNavigation(navController)
    }

    /**
     * The network inspector's OkHttp interceptor (one instance per process). Add it LAST among the application
     * interceptors, so the capture sees what the app's own interceptors (auth, logging) send and mocks go through
     * them on the way back:
     *
     * ```
     * // Retrofit
     * val client = OkHttpClient.Builder()
     *     .addInterceptor(authInterceptor)
     *     .addInterceptor(Lionscope.okHttpInterceptor())
     *     .build()
     * val retrofit = Retrofit.Builder().baseUrl("https://api.example.com/").client(client).build()
     *
     * // Ktor on Android (OkHttp engine, androidMain)
     * val http = HttpClient(OkHttp) { engine { addInterceptor(Lionscope.okHttpInterceptor()) } }
     * ```
     *
     * It does nothing but `chain.proceed(chain.request())` unless a Lionscope profiling session runs (server and SDK
     * on device protocol v7). During a session it records each exchange for the dashboard's Network tab: method,
     * URL, headers, timings and, for text types (JSON, XML, forms, GraphQL, `text/`), the first 64 KB of each body.
     * Values of `Authorization`, `Cookie`, `Set-Cookie` and of headers, query parameters and form fields whose names
     * look like tokens, secrets, keys, sessions or passwords are redacted on the device; JSON and XML bodies are not.
     * The response body is never read by Lionscope: it copies what the app reads. Mock rules set in the dashboard
     * answer matching requests without a network call (one `Lionscope` logcat line per mocked request); they apply
     * only during the session that set them. Added with `addNetworkInterceptor` it records but never mocks.
     *
     * Needs OkHttp 4.x or 5.x on the app's classpath (Lionscope does not bring it); never called, it never loads
     * OkHttp classes. Not covered: Ktor CIO / Darwin engines, `HttpURLConnection`, WebView, gRPC. `lionscope-noop`
     * returns a pass-through interceptor, so release builds keep the same code.
     */
    fun okHttpInterceptor(): Interceptor = LionscopeOkHttpInterceptor.shared
}
