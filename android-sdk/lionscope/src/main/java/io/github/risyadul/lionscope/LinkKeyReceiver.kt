package io.github.risyadul.lionscope

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Process
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Takes the v7 link key from the server: `am broadcast -n <package>/io.github.risyadul.lionscope.LinkKeyReceiver
 * --es key <64 hex> --ei pid <pid>`. Exported but guarded by `android.permission.DUMP` (manifest), which only the
 * shell and the system hold, so no other app can set it. Cheap, never throws, never logs the key.
 */
internal class LinkKeyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        try {
            val extras = intent ?: return
            LinkKey.accept(extras.getStringExtra(EXTRA_KEY), extras.getIntExtra(EXTRA_PID, -1), Process.myPid())
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            // A malformed broadcast is ignored.
        }
    }

    private companion object {
        const val EXTRA_KEY = "key"
        const val EXTRA_PID = "pid"
    }
}

/** The latest link key handed to this process (null until one arrives). */
internal object LinkKey {
    @Volatile
    var current: ByteArray? = null
        private set

    /** Keeps [hex] (64 hex digits) as the key if [pid] is this process ([myPid]); returns whether it did. */
    fun accept(hex: String?, pid: Int, myPid: Int): Boolean {
        if (pid != myPid || hex == null) return false
        val key = LinkProof.fromHex(hex, LINK_KEY_BYTES) ?: return false
        current = key
        return true
    }
}

/** The hello's nonce and the welcome's proof (protocol/src/wire.ts, `LINK_KEY_RECEIVER`). */
internal object LinkProof {
    private const val HMAC = "HmacSHA256"
    private val random by lazy { SecureRandom() }

    /** [LINK_NONCE_BYTES] random bytes, lower-case hex; a fresh one per connection. */
    fun newNonce(): String = hex(ByteArray(LINK_NONCE_BYTES).also { random.nextBytes(it) })

    /** hex(HMAC-SHA256([key], `<nonce>:<protocolVersion>:<mode>`)), lower case. */
    fun proof(key: ByteArray, nonce: String, protocolVersion: Int, mode: String): String {
        val mac = Mac.getInstance(HMAC)
        mac.init(SecretKeySpec(key, HMAC))
        return hex(mac.doFinal("$nonce:$protocolVersion:$mode".toByteArray(Charsets.UTF_8)))
    }

    /** Whether [proof] is the session proof for [nonce] under [key]; compared in constant time. */
    fun verifySession(key: ByteArray?, nonce: String, protocolVersion: Int, proof: String?): Boolean {
        if (key == null || proof == null) return false
        val expected = proof(key, nonce, protocolVersion, SESSION_MODE).toByteArray(Charsets.US_ASCII)
        return MessageDigest.isEqual(expected, proof.toByteArray(Charsets.US_ASCII))
    }

    fun hex(bytes: ByteArray): String {
        val out = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            val value = bytes[i].toInt() and 0xFF
            out[2 * i] = HEX_DIGITS[value ushr 4]
            out[2 * i + 1] = HEX_DIGITS[value and 0x0F]
        }
        return String(out)
    }

    /** [size] bytes from exactly `2 * size` lower-case hex digits (as the server sends them), else null. */
    fun fromHex(hex: String, size: Int): ByteArray? {
        if (hex.length != size * 2) return null
        val out = ByteArray(size)
        for (i in 0 until size) {
            val high = HEX_DIGITS.indexOf(hex[2 * i])
            val low = HEX_DIGITS.indexOf(hex[2 * i + 1])
            if (high < 0 || low < 0) return null
            out[i] = (high * 16 + low).toByte()
        }
        return out
    }

    private const val SESSION_MODE = "session"
    private const val HEX_DIGITS = "0123456789abcdef"
}
