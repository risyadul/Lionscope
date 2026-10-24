package io.github.risyadul.lionscope.testapp

import io.reactivex.Observable
import io.reactivex.Scheduler
import io.reactivex.functions.Consumer

/** Stands in for app code that subscribes a chain (outside the SDK's own package, like an app's classes). */
object ShopChains {
    fun subscribeItems(scheduler: Scheduler, consumer: Consumer<Int>) {
        Observable.just(1).observeOn(scheduler).map { it + 1 }.subscribe(consumer)
    }
}
