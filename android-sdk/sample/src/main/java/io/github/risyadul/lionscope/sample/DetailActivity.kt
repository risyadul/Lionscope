package io.github.risyadul.lionscope.sample

import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class DetailActivity : AppCompatActivity(), ScreenName {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_detail)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        intent?.data?.let { uri ->
            findViewById<TextView>(R.id.detail_body).text = getString(R.string.detail_deep_link, uri.toString())
        }
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }

    override fun getScreen(): Screen = Screen.DETAIL
}
