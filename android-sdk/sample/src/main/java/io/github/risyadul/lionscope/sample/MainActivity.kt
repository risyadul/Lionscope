package io.github.risyadul.lionscope.sample

import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import com.google.android.material.bottomnavigation.BottomNavigationView
import io.github.risyadul.lionscope.Lionscope

class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        findViewById<TextView>(R.id.status).text =
            getString(R.string.status_format, Lionscope.VERSION, Lionscope.isActive().toString())

        val nav = findViewById<BottomNavigationView>(R.id.bottom_nav)
        nav.setOnItemSelectedListener { item ->
            show(
                when (item.itemId) {
                    R.id.tab_list -> JankListFragment()
                    R.id.tab_pager -> LegacyPagerFragment()
                    R.id.tab_more -> MoreContainerFragment()
                    else -> HomeFragment()
                }
            )
            true
        }
        if (savedInstanceState == null) show(HomeFragment())
    }

    private fun show(fragment: Fragment) {
        supportFragmentManager.beginTransaction()
            .replace(R.id.container, fragment)
            .commit()
    }
}
