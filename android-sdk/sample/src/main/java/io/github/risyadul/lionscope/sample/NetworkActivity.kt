package io.github.risyadul.lionscope.sample

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import io.github.risyadul.lionscope.Lionscope
import okhttp3.Call
import okhttp3.Callback
import okhttp3.FormBody
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The network demo: requests to `sample-api.mjs` on the laptop through OkHttp with `Lionscope.okHttpInterceptor()`,
 * added last after the app's own interceptor (a fake bearer token, which Lionscope redacts). Mock a response in the
 * dashboard and press the button again: the request never reaches the API.
 */
class NetworkActivity : AppCompatActivity(), ScreenName {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var baseUrl: EditText
    private lateinit var log: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_network)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        baseUrl = findViewById(R.id.base_url)
        log = findViewById(R.id.network_log)
        val demos = listOf(
            R.id.get_items to { get("/v1/items?page=2&token=sample-query-token") },
            R.id.get_item to { get("/v1/items/42") },
            R.id.post_cart to { post("/v1/cart", JSON_CART.toRequestBody(JSON)) },
            R.id.post_login to { post("/v1/login", FormBody.Builder().add("user", "ana").add("password", "hunter2").build()) },
            R.id.get_slow to { get("/v1/slow?ms=2000") },
            R.id.get_missing to { get("/v1/missing") },
            R.id.get_error to { get("/v1/error") },
            R.id.get_large to { get("/v1/large") },
            R.id.get_gzip to { get("/v1/gzip", gzip = true) },
            R.id.get_image to { get("/v1/image.png") },
            R.id.get_events to { get("/v1/events") },
            R.id.get_unreachable to { call(Request.Builder().url(UNREACHABLE_URL).build()) },
        )
        for ((id, run) in demos) findViewById<View>(id).setOnClickListener { run() }
        findViewById<View>(R.id.run_all).setOnClickListener { demos.forEach { (_, run) -> run() } }
        findViewById<View>(R.id.clear_log).setOnClickListener { log.text = "" }
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }

    override fun getScreen(): Screen = Screen.NETWORK

    private fun get(path: String, gzip: Boolean = false) {
        val url = url(path) ?: return
        val request = Request.Builder().url(url)
        // With its own Accept-Encoding the app gets the gzip bytes; Lionscope still shows the JSON inside.
        if (gzip) request.header("Accept-Encoding", "gzip")
        call(request.build())
    }

    private fun post(path: String, body: okhttp3.RequestBody) {
        val url = url(path) ?: return
        call(Request.Builder().url(url).post(body).build())
    }

    private fun url(path: String): String? {
        val url = baseUrl.text.toString().trimEnd('/') + path
        if (url.toHttpUrlOrNull() == null) {
            append(getString(R.string.network_result_failed, "GET", path, "invalid base URL", 0L))
            return null
        }
        return url
    }

    private fun call(request: Request) {
        val started = SystemClock.elapsedRealtime()
        client.newCall(request).enqueue(object : Callback {
            override fun onResponse(call: Call, response: Response) {
                val bytes = response.use { it.body?.bytes()?.size ?: 0 }
                val ms = SystemClock.elapsedRealtime() - started
                append(getString(R.string.network_result_ok, request.method, request.url.encodedPath, response.code, ms, bytes))
            }

            override fun onFailure(call: Call, e: IOException) {
                val ms = SystemClock.elapsedRealtime() - started
                append(getString(R.string.network_result_failed, request.method, request.url.encodedPath, e.javaClass.simpleName, ms))
            }
        })
    }

    private fun append(line: String) {
        main.post { log.append(if (log.text.isEmpty()) line else "\n$line") }
    }

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
        const val JSON_CART = """{"sku":"A-1","qty":2}"""
        /** Port 9 (discard) is closed on the laptop: the connection is refused. */
        const val UNREACHABLE_URL = "http://10.0.2.2:9/v1/items"

        /** Stands in for an app's own auth interceptor. */
        val auth = Interceptor { chain ->
            chain.proceed(chain.request().newBuilder().header("Authorization", "Bearer sample-token").build())
        }

        val client: OkHttpClient = OkHttpClient.Builder()
            .addInterceptor(auth)
            .addInterceptor(Lionscope.okHttpInterceptor())
            .callTimeout(15, TimeUnit.SECONDS)
            .build()
    }
}
