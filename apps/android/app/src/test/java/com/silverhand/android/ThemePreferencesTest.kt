package com.silverhand.android

import android.content.SharedPreferences
import java.lang.reflect.Proxy
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlin.concurrent.thread

/** Controlled JVM failures, not Android disk/Activity lifecycle evidence. */
object ThemePreferencesTest {
    private class Fake {
        var memory: String? = null
        var committed: String? = null
        var result = true
        var failure: RuntimeException? = null
        var commits = 0
        var onCommit: () -> Unit = {}
        private var pending: String? = null
        val editor = Proxy.newProxyInstance(SharedPreferences.Editor::class.java.classLoader,
            arrayOf(SharedPreferences.Editor::class.java)) { proxy, method, args ->
            when (method.name) {
                "putString" -> { pending = args!![1] as String?; proxy }
                "commit" -> {
                    commits++
                    onCommit()
                    memory = pending // Android may expose this even on failure.
                    failure?.let { throw it }
                    if (result) committed = pending
                    result
                }
                else -> error("Unexpected Editor call ${method.name}")
            }
        } as SharedPreferences.Editor
        val prefs = Proxy.newProxyInstance(SharedPreferences::class.java.classLoader,
            arrayOf(SharedPreferences::class.java)) { _, method, _ ->
            when (method.name) {
                "getString" -> memory
                "edit" -> editor
                else -> error("Unexpected preferences call ${method.name}")
            }
        } as SharedPreferences
    }
    private fun rejected(action: () -> Unit) {
        try { action() } catch (_: IllegalStateException) { return }
        throw AssertionError("Expected unconfirmed read/save")
    }
    @JvmStatic fun main(args: Array<String>) {
        var cases = 0
        run {
            val store = ThemePreferences(); val fake = Fake()
            check(store.read({ fake.prefs }) {} == null)
            for (id in listOf("glass", "studio-light", "poster", "iris", "slack-dark")) {
                store.save({ fake.prefs }, id) {}; check(store.read({ fake.prefs }) {} == id); check(fake.committed == id)
            }
            val before = fake.commits
            store.save({ fake.prefs }, "slack-dark") {}
            check(fake.commits == before + 1) // equal id must still commit
            cases++
        }
        run {
            val store = ThemePreferences(); val fake = Fake()
            store.save({ fake.prefs }, "iris") {}; fake.result = false
            rejected { store.save({ fake.prefs }, "glass") {} }
            check(fake.memory == "glass" && fake.committed == "iris")
            rejected { store.read({ fake.prefs }) {} }
            fake.result = true; store.save({ fake.prefs }, "poster") {}
            check(store.read({ fake.prefs }) {} == "poster")
            cases++
        }
        run {
            val store = ThemePreferences(); val fake = Fake()
            fake.failure = IllegalStateException("disk error")
            rejected { store.save({ fake.prefs }, "glass") {} }
            rejected { store.read({ fake.prefs }) {} }
            fake.failure = null; store.save({ fake.prefs }, "iris") {}
            check(store.read({ fake.prefs }) {} == "iris")
            cases++
        }
        run {
            val store = ThemePreferences(); val fake = Fake()
            fake.memory = "invalid"; rejected { store.read({ fake.prefs }) {} }
            try { store.save({ fake.prefs }, "invalid") {}; error("Invalid id accepted") }
            catch (_: IllegalArgumentException) { check(fake.commits == 0) }
            cases++
        }
        run {
            val store = ThemePreferences(); val fake = Fake()
            val enteredCommit = CountDownLatch(1); val releaseCommit = CountDownLatch(1)
            val waiterStarted = CountDownLatch(1)
            val holderFailure = AtomicReference<Throwable?>(); val waiterFailure = AtomicReference<Throwable?>()
            val oldOwner = Job(); val request = Job(oldOwner)
            fake.onCommit = {
                if (fake.commits == 1) {
                    enteredCommit.countDown()
                    check(releaseCommit.await(2, TimeUnit.SECONDS)) { "Commit holder not released" }
                }
            }
            val holder = thread(name = "theme-lock-holder", isDaemon = true) {
                try { store.save({ fake.prefs }, "iris") {} }
                catch (error: Throwable) { holderFailure.set(error) }
            }
            var waiter: Thread? = null
            try {
                check(enteredCommit.await(1, TimeUnit.SECONDS))
                waiter = thread(name = "theme-canceled-waiter", isDaemon = true) {
                    waiterStarted.countDown()
                    try { store.save({ fake.prefs }, "glass") { request.ensureActive() } }
                    catch (error: Throwable) { waiterFailure.set(error) }
                }
                check(waiterStarted.await(1, TimeUnit.SECONDS))
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1)
                while (waiter.state != Thread.State.BLOCKED && System.nanoTime() < deadline) Thread.yield()
                check(waiter.state == Thread.State.BLOCKED) { "Request never blocked on theme monitor" }
                oldOwner.cancel() // Actual parent/request Job cancellation while the monitor is held.
                check(request.isCancelled)
            } finally {
                releaseCommit.countDown()
                holder.join(1000); waiter?.join(1000)
            }
            check(!holder.isAlive && waiter?.isAlive == false)
            check(holderFailure.get() == null)
            check(waiterFailure.get() is CancellationException)
            check(fake.commits == 1 && fake.memory == "iris" && fake.committed == "iris")
            val freshRequest = Job()
            store.save({ fake.prefs }, "poster") { freshRequest.ensureActive() }
            check(fake.commits == 2 && store.read({ fake.prefs }) { freshRequest.ensureActive() } == "poster")
            freshRequest.cancel()
            cases++
        }
        println("{\"cases\":$cases,\"failed\":0}")
    }
}
