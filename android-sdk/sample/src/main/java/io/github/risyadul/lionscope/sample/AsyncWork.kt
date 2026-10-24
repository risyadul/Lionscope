package io.github.risyadul.lionscope.sample

import io.reactivex.Observable
import io.reactivex.android.schedulers.AndroidSchedulers
import io.reactivex.disposables.Disposable
import io.reactivex.schedulers.Schedulers
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Main-thread work that arrives through RxJava and coroutines: the stack of such a stall shows the scheduler or the
 * dispatcher and the lambda, and Lionscope adds the chain's subscribe site or the coroutine's name.
 */
object AsyncWork {
    private const val BLOCK_MS = 300L

    /** Loads on io, then "renders" on the main thread for [BLOCK_MS]. */
    fun loadPricesWithRx(onDone: (Int) -> Unit): Disposable =
        Observable.fromCallable { listOf(12, 30, 7) }
            .subscribeOn(Schedulers.io())
            .observeOn(AndroidSchedulers.mainThread())
            .map { prices -> renderPrices(prices) }
            .subscribe(onDone)

    /** Loads on IO, then sums the cart on the main thread for [BLOCK_MS], in a coroutine named `refresh-cart`. */
    fun refreshCartWithCoroutine(scope: CoroutineScope, onDone: (Int) -> Unit): Job =
        scope.launch(CoroutineName("refresh-cart")) {
            val cart = withContext(Dispatchers.IO) { listOf(3, 4, 5) }
            onDone(sumCart(cart))
        }

    private fun renderPrices(prices: List<Int>): Int {
        Thread.sleep(BLOCK_MS)
        return prices.sum()
    }

    private fun sumCart(cart: List<Int>): Int {
        Thread.sleep(BLOCK_MS)
        return cart.sum()
    }
}
