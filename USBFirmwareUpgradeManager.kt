package com.hsinghai.hsinghaipiano.midi.usb.upgrade

import android.os.Handler
import android.os.Looper
import com.clj.fastble.utils.HexUtil
import com.hsinghai.hsinghaipiano.log.POPLogger
import com.hsinghai.hsinghaipiano.midi.usb.USBPPCompatDevice
import java.io.BufferedReader
import java.io.File
import java.io.FileReader
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * USB固件升级管理器
 *
 * 功能说明：
 * - 实现星海弹唱琴USB固件升级协议
 * - 支持版本查询、固件传输、进度回调
 * - 自动重试机制、超时处理
 *
 * 协议格式：
 * F0 53 57 CMD LEN_H LEN_L [Params] F7
 *
 * 使用示例：
 * ```kotlin
 * val manager = USBFirmwareUpgradeManager(usbDevice)
 * manager.setCallback(object : USBFirmwareUpgradeCallback {
 *     override fun onVersionReceived(version: String) {
 *         Log.d("Upgrade", "Version: $version")
 *     }
 *     override fun onUpgradeProgress(progress: Int, current: Int, total: Int) {
 *         progressBar.progress = progress
 *     }
 *     override fun onUpgradeSuccess() {
 *         Toast.makeText(context, "升级成功", Toast.LENGTH_SHORT).show()
 *     }
 *     override fun onUpgradeFailed(code: Int, msg: String) {
 *         Toast.makeText(context, "升级失败: $msg", Toast.LENGTH_SHORT).show()
 *     }
 *     override fun onUpgradeStateChanged(state: USBFirmwareUpgradeCallback.UpgradeState) {
 *         tvStatus.text = state.name
 *     }
 * })
 *
 * // 查询版本
 * manager.queryFirmwareVersion()
 *
 * // 开始升级（需要READ_EXTERNAL_STORAGE权限）
 * manager.startUpgrade("/sdcard/firmware.upg")
 * ```
 *
 * @param usbDevice USB设备实例
 * @author Auto Generated
 * @date 2025-01-16
 */
class USBFirmwareUpgradeManager(private val usbDevice: USBPPCompatDevice) {

    companion object {
        private const val TAG = "USBFirmwareUpgrade"

        // ==================== 协议常量 ====================
        private const val STX: Byte = 0xF0.toByte()          // 消息起始标志
        private const val SIGN1: Byte = 0x53                  // 厂商标识1 'S'
        private const val SIGN2: Byte = 0x57                  // 厂商标识2 'W'
        private const val ETX: Byte = 0xF7.toByte()          // 消息结束标志

        // 命令定义
        private const val CMD_VERSION_QUERY: Byte = 0x00     // 版本查询
        private const val CMD_INIT: Byte = 0x01              // 初始化下载
        private const val CMD_DATA_PKT_BASE: Byte = 0x02     // 数据包基础CMD（动态递增）
        private const val CMD_FINISH: Byte = 0x10            // 结束下载

        // 响应码
        private const val ACK: Byte = 0x06                   // 确认
        private const val NAK: Byte = 0x15                   // 否定
        private const val CRC_ERROR: Byte = 0x13             // CRC错误

        // 参数定义
        private const val PARAM_TRANSFER_END: Byte = 0x04    // 传输结束
        private const val PARAM_TRANSFER_CANCEL: Byte = 0x1B // 取消传输

        // ==================== 配置参数 ====================
        private const val LINES_PER_CMD = 128                // 每个CMD传输的行数
        private const val MAX_RETRY_COUNT = 3                // 最大重试次数

        // 超时时间（根据行业经验设置）
        private const val TIMEOUT_VERSION_QUERY = 3000L      // 版本查询超时: 3秒
        private const val TIMEOUT_INIT = 5000L               // 初始化超时: 5秒
        private const val TIMEOUT_DATA_TRANSFER = 5000L      // 数据传输超时: 5秒
        private const val TIMEOUT_FINISH = 10000L            // 结束超时: 10秒
    }

    // ==================== 成员变量 ====================
    private var callback: USBFirmwareUpgradeCallback? = null
    private val handler = Handler(Looper.getMainLooper())
    private val isUpgrading = AtomicBoolean(false)
    private var currentState = USBFirmwareUpgradeCallback.UpgradeState.IDLE

    // 响应同步机制
    private var responseLatch: CountDownLatch? = null
    private var responseData: ByteArray? = null
    private val responseLock = Object()

    // ==================== 可选配置 ====================
    /**
     * 是否在每行数据后添加0xF7终止符（实验性选项）
     * 默认false，如果硬件需要可以设置为true
     */
    var addLineTerminator: Boolean = false

    // ==================== 公开方法 ====================

    /**
     * 设置回调接口
     */
    fun setCallback(callback: USBFirmwareUpgradeCallback?) {
        this.callback = callback
    }

    /**
     * 查询固件版本
     *
     * 协议：APP -> Piano: F0 53 57 00 00 00 F7
     * 响应：Piano -> APP: F0 53 57 00 00 04 00 01 00 00 F7 (版本1.00)
     *
     * 需要权限：无需特殊权限
     */
    fun queryFirmwareVersion() {
        POPLogger.d("$TAG - 开始查询固件版本")
        changeState(USBFirmwareUpgradeCallback.UpgradeState.CHECKING)

        Thread {
            try {
                val command = buildCommand(CMD_VERSION_QUERY, byteArrayOf())
                val response = sendCommandAndWaitResponse(command, TIMEOUT_VERSION_QUERY)

                if (response != null && response.size >= 9) {
                    // 解析版本号
                    val majorVersion = response[7].toInt() and 0xFF
                    val minorHigh = response[8].toInt() and 0xFF
                    val minorLow = response[9].toInt() and 0xFF
                    val version = String.format("V%d.%02d", majorVersion, minorHigh * 10 + minorLow)

                    POPLogger.i("$TAG - 固件版本: $version")
                    handler.post {
                        callback?.onVersionReceived(version)
                    }
                } else {
                    POPLogger.e("$TAG - 版本查询失败：响应数据无效")
                }

                changeState(USBFirmwareUpgradeCallback.UpgradeState.IDLE)

            } catch (e: Exception) {
                POPLogger.e("$TAG - 版本查询异常: ${e.message}")
                changeState(USBFirmwareUpgradeCallback.UpgradeState.IDLE)
            }
        }.start()
    }

    /**
     * 开始固件升级
     *
     * 需要权限：
     * - android.permission.READ_EXTERNAL_STORAGE（如果文件在外部存储）
     *
     * @param upgFilePath .upg升级文件的完整路径
     */
    fun startUpgrade(file: File) {
        if (isUpgrading.get()) {
            POPLogger.w("$TAG - 升级已在进行中")
            notifyError(
                USBFirmwareUpgradeCallback.ERROR_UPGRADE_IN_PROGRESS,
                "升级已在进行中，请勿重复操作"
            )
            return
        }

//        POPLogger.i("$TAG - 开始固件升级: $upgFilePath")

        // 检查USB连接
        if (!checkUSBConnection()) {
            notifyError(
                USBFirmwareUpgradeCallback.ERROR_USB_NOT_CONNECTED,
                "USB设备未连接或未准备好"
            )
            return
        }

        // 检查文件
//        val upgFile = File(upgFilePath)
        if (!file.exists()) {
            notifyError(
                USBFirmwareUpgradeCallback.ERROR_FILE_NOT_FOUND,
                "升级文件不存在: "
            )
            return
        }

        if (!file.canRead()) {
            notifyError(
                USBFirmwareUpgradeCallback.ERROR_FILE_READ_ERROR,
                "无法读取升级文件，请检查权限"
            )
            return
        }

        isUpgrading.set(true)
        changeState(USBFirmwareUpgradeCallback.UpgradeState.INITIALIZING)

        // 在后台线程执行升级
        Thread {
            try {
                performUpgrade(file)
            } catch (e: Exception) {
                POPLogger.e("$TAG - 升级异常: ${e.message}")
                e.printStackTrace()
                notifyError(
                    USBFirmwareUpgradeCallback.ERROR_UNKNOWN,
                    "升级异常: ${e.message ?: "未知错误"}"
                )
            } finally {
                isUpgrading.set(false)
            }
        }.start()
    }

    /**
     * 取消升级
     */
    fun cancelUpgrade() {
        if (!isUpgrading.get()) {
            POPLogger.w("$TAG - 当前没有进行中的升级任务")
            return
        }

        POPLogger.i("$TAG - 取消固件升级")

        // 发送取消命令
        try {
            val command = buildCommand(CMD_FINISH, byteArrayOf(PARAM_TRANSFER_CANCEL))
            sendCommand(command)
        } catch (e: Exception) {
            POPLogger.e("$TAG - 发送取消命令失败: ${e.message}")
        }

        isUpgrading.set(false)
        changeState(USBFirmwareUpgradeCallback.UpgradeState.IDLE)
    }

    /**
     * 处理接收到的升级协议响应
     * 注意：此方法需要从USBPPCompatDevice中调用
     */
    fun handleUpgradeResponse(data: ByteArray) {
        if (!isValidUpgradeResponse(data)) {
            return
        }

        POPLogger.v("$TAG - 收到升级响应: ${HexUtil.formatHexString(data, true)}")

        synchronized(responseLock) {
            responseData = data
            responseLatch?.countDown()
        }
    }

    // ==================== 私有方法 ====================

    /**
     * 执行升级流程
     */
    private fun performUpgrade(upgFile: File) {
        POPLogger.d("$TAG - 开始读取升级文件...")

        // 1. 读取.upg文件内容
        val fileLines = try {
            readUpgFile(upgFile)
        } catch (e: Exception) {
            POPLogger.e("$TAG - 文件读取失败: ${e.message}")
            notifyError(
                USBFirmwareUpgradeCallback.ERROR_FILE_READ_ERROR,
                "文件读取失败: ${e.message}"
            )
            return
        }

        if (fileLines.isEmpty()) {
            notifyError(
                USBFirmwareUpgradeCallback.ERROR_FILE_FORMAT_ERROR,
                "升级文件为空或格式错误"
            )
            return
        }

        POPLogger.d("$TAG - 文件读取完成，共 ${fileLines.size} 行数据")

        // 2. 初始化升级
        if (!initializeUpgrade()) {
            return
        }

        // 短暂延时，确保硬件准备好
        Thread.sleep(200)

        // 3. 分包传输数据
        if (!transferData(fileLines)) {
            return
        }

        // 4. 结束升级
        if (!finishUpgrade()) {
            return
        }

        // 5. 升级成功
        POPLogger.i("$TAG - 固件升级成功！")
        changeState(USBFirmwareUpgradeCallback.UpgradeState.SUCCESS)
        handler.post {
            callback?.onUpgradeSuccess()
        }
    }

    /**
     * 读取.upg文件内容
     * 需要权限：READ_EXTERNAL_STORAGE（如果文件在外部存储）
     */
    private fun readUpgFile(file: File): List<String> {
        val lines = mutableListOf<String>()

        BufferedReader(FileReader(file)).use { reader ->
            var line: String?
            while (reader.readLine().also { line = it } != null) {
                line?.let {
                    val trimmed = it.trim()
                    if (trimmed.isNotEmpty()) {
                        lines.add(trimmed)
                    }
                }
            }
        }

        POPLogger.d("$TAG - 读取到 ${lines.size} 行有效数据")
        return lines
    }

    /**
     * 初始化升级
     */
    private fun initializeUpgrade(): Boolean {
        POPLogger.d("$TAG - 发送初始化命令...")
        changeState(USBFirmwareUpgradeCallback.UpgradeState.INITIALIZING)

        val command = buildCommand(CMD_INIT, byteArrayOf())
        val response = sendCommandAndWaitResponse(command, TIMEOUT_INIT)

        val success = checkAckResponse(response)

        if (!success) {
            notifyError(
                USBFirmwareUpgradeCallback.ERROR_INIT_FAILED,
                "初始化失败：未收到ACK响应"
            )
        } else {
            POPLogger.i("$TAG - 初始化成功")
        }

        return success
    }

    /**
     * 传输数据
     *
     * 修改说明：
     * 1. CMD动态计算，支持任意行数的升级文件
     * 2. 每次只发送一行数据，PKT表示该行在当前CMD段内的行号（0-127）
     * 3. 每发送一行等待一次ACK响应
     */
    private fun transferData(fileLines: List<String>): Boolean {
        POPLogger.d("$TAG - 开始传输数据...")
        changeState(USBFirmwareUpgradeCallback.UpgradeState.TRANSFERRING)

        val totalLines = fileLines.size
        POPLogger.i("$TAG - 总行数: $totalLines")

        var consecutiveFailures = 0

        for (lineIndex in 0 until totalLines) {
            if (!isUpgrading.get()) {
                POPLogger.w("$TAG - 升级已取消")
                return false
            }

            // 计算当前CMD：每128行递增一次
            val cmdOffset = lineIndex / LINES_PER_CMD
            val cmd = (CMD_DATA_PKT_BASE.toInt() + cmdOffset).toByte()

            // 计算PKT：当前行在CMD段内的行号（0-127）
            val pktNumber = (lineIndex % LINES_PER_CMD).toByte()

            // 获取当前行数据
            val currentLine = fileLines[lineIndex]

            POPLogger.v("$TAG - 发送行 $lineIndex: CMD=0x${String.format("%02X", cmd)}, PKT=$pktNumber")

            // 发送单行数据，支持重试
            val success = sendSingleLineWithRetry(cmd, pktNumber, currentLine)

            if (!success) {
                consecutiveFailures++
                if (consecutiveFailures >= MAX_RETRY_COUNT) {
                    notifyError(
                        USBFirmwareUpgradeCallback.ERROR_TRANSFER_FAILED,
                        "数据传输失败，行号: $lineIndex"
                    )
                    return false
                }
                // 失败后重试当前行，不递增lineIndex
                continue
            } else {
                consecutiveFailures = 0

                // 更新进度（每10行或最后一行更新一次，减少UI刷新）
                if (lineIndex % 10 == 0 || lineIndex == totalLines - 1) {
                    val progress = ((lineIndex + 1) * 100) / totalLines
                    POPLogger.d("$TAG - 传输进度: $progress% ($lineIndex/$totalLines)")
                    handler.post {
                        callback?.onUpgradeProgress(progress, lineIndex + 1, totalLines)
                    }
                }
            }
        }

        POPLogger.i("$TAG - 数据传输完成")
        return true
    }

    /**
     * 发送单行数据（带重试）
     */
    private fun sendSingleLineWithRetry(cmd: Byte, pktNumber: Byte, line: String): Boolean {
        var retryCount = 0

        while (retryCount < MAX_RETRY_COUNT) {
            val success = sendSingleLine(cmd, pktNumber, line)
            if (success) {
                return true
            }

            retryCount++
            if (retryCount < MAX_RETRY_COUNT) {
                POPLogger.w("$TAG - 行数据发送失败，第 $retryCount 次重试...")
                Thread.sleep(100)  // 重试前等待100ms
            }
        }

        POPLogger.e("$TAG - 行数据发送失败，已重试 $MAX_RETRY_COUNT 次")
        return false
    }

    /**
     * 发送单行数据
     */
    private fun sendSingleLine(cmd: Byte, pktNumber: Byte, line: String): Boolean {
        // 1. 构建单行数据（不添加任何终止符，发送原始行数据）
        val lineBytes = line.toByteArray(Charsets.US_ASCII)

        // 2. 可选：添加终止符（实验性功能）
        val dataBytes = if (addLineTerminator) {
            // 如果启用，在行数据后添加0xF7
            lineBytes + ETX
        } else {
            lineBytes
        }

        // 3. 使用buildDataCommand构建数据传输命令（不带LEN字段）
        // 格式：F0 53 57 CMD PKT [数据] F7
        val command = buildDataCommand(cmd, pktNumber, dataBytes)

        // 4. 发送并等待响应（超时5秒）
        val response = sendCommandAndWaitResponse(command, TIMEOUT_DATA_TRANSFER)

        // 5. 检查响应结果
        return when {
            response == null -> {
                POPLogger.w("$TAG - 行数据发送超时 (CMD=0x${String.format("%02X", cmd)}, PKT=$pktNumber)")
                false
            }
            checkAckResponse(response) -> {
                POPLogger.v("$TAG - 收到ACK (CMD=0x${String.format("%02X", cmd)}, PKT=$pktNumber)")
                true
            }
            checkCrcError(response) -> {
                POPLogger.w("$TAG - CRC校验错误 (CMD=0x${String.format("%02X", cmd)}, PKT=$pktNumber)")
                false
            }
            else -> {
                POPLogger.w("$TAG - 收到NAK响应 (CMD=0x${String.format("%02X", cmd)}, PKT=$pktNumber)")
                false
            }
        }
    }

    /**
     * 发送数据包（带重试）
     */
    private fun sendDataPacketWithRetry(cmd: Byte, pktNumber: Byte, lines: List<String>): Boolean {
        var retryCount = 0

        while (retryCount < MAX_RETRY_COUNT) {
            val success = sendDataPacket(cmd, pktNumber, lines)
            if (success) {
                return true
            }

            retryCount++
            if (retryCount < MAX_RETRY_COUNT) {
                POPLogger.w("$TAG - 数据包发送失败，第 $retryCount 次重试...")
                Thread.sleep(200)  // 重试前等待200ms
            }
        }

        POPLogger.e("$TAG - 数据包发送失败，已重试 $MAX_RETRY_COUNT 次")
        return false
    }

    /**
     * 发送单个数据包
     *
     * 【修改3】添加可选的0xF7行终止符
     */
    private fun sendDataPacket(cmd: Byte, pktNumber: Byte, lines: List<String>): Boolean {
        // 构建数据内容
        val dataBytes = mutableListOf<Byte>()

        for (line in lines) {
            // 将每行转换为字节
            val lineBytes = line.toByteArray(Charsets.US_ASCII)
            dataBytes.addAll(lineBytes.toList())

            // 【可选功能】如果启用，在每行后添加0xF7终止符
            if (addLineTerminator) {
                dataBytes.add(ETX)  // 0xF7
                POPLogger.v("$TAG - 已添加行终止符0xF7")
            } else {
                // 标准模式：添加换行符
                dataBytes.add(0x0D)  // CR
                dataBytes.add(0x0A)  // LF
            }
        }

        // 构建完整命令：PKT号 + 数据内容
        val params = byteArrayOf(pktNumber) + dataBytes.toByteArray()
        val command = buildCommand(cmd, params)

        // 发送并等待响应
        val response = sendCommandAndWaitResponse(command, TIMEOUT_DATA_TRANSFER)

        return when {
            response == null -> {
                POPLogger.w("$TAG - 数据包发送超时")
                false
            }
            checkAckResponse(response) -> true
            checkCrcError(response) -> {
                POPLogger.w("$TAG - CRC校验错误")
                false
            }
            else -> {
                POPLogger.w("$TAG - 收到NAK响应")
                false
            }
        }
    }

    /**
     * 结束升级
     */
    private fun finishUpgrade(): Boolean {
        POPLogger.d("$TAG - 发送结束命令...")
        changeState(USBFirmwareUpgradeCallback.UpgradeState.FINISHING)

        val command = buildCommand(CMD_FINISH, byteArrayOf(PARAM_TRANSFER_END))
        val response = sendCommandAndWaitResponse(command, TIMEOUT_FINISH)

        val success = checkAckResponse(response)

        if (!success) {
            notifyError(
                USBFirmwareUpgradeCallback.ERROR_FINISH_FAILED,
                "结束升级失败：未收到ACK响应"
            )
        } else {
            POPLogger.i("$TAG - 结束命令成功")
        }

        return success
    }

    /**
     * 构建命令（带LEN字段）
     * 格式：F0 53 57 CMD LEN_H LEN_L [Params] F7
     * 用于：版本查询、初始化、结束等控制命令
     */
    private fun buildCommand(cmd: Byte, params: ByteArray): ByteArray {
        val len = params.size
        val command = ByteArray(5 + len + 1)

        command[0] = STX
        command[1] = SIGN1
        command[2] = SIGN2
        command[3] = cmd
//        command[4] = ((len shr 8) and 0xFF).toByte()  // LEN高字节
//        command[5] = (len and 0xFF).toByte()          // LEN低字节

        command[4] = (len and 0xFF).toByte()          // LEN低字节

        if (params.isNotEmpty()) {
            System.arraycopy(params, 0, command, 5, params.size)
        }

        command[command.size - 1] = ETX

        return command
    }

    /**
     * 构建数据传输命令（不带LEN字段）
     * 格式：F0 53 57 CMD PKT [Line Data] F7
     * 用于：固件数据传输（CMD 0x02~0x05等）
     */
    private fun buildDataCommand(cmd: Byte, pkt: Byte, data: ByteArray): ByteArray {
        val command = ByteArray(5 + data.size + 1)

        command[0] = STX
        command[1] = SIGN1
        command[2] = SIGN2
        command[3] = cmd
        command[4] = pkt

        if (data.isNotEmpty()) {
            System.arraycopy(data, 0, command, 5, data.size)
        }

        command[command.size - 1] = ETX

        return command
    }

    /**
     * 发送命令
     */
    private fun sendCommand(command: ByteArray) {
        POPLogger.v("$TAG - >>> 发送: ${HexUtil.formatHexString(command, true)}")
        usbDevice.sendMidiSystemExclusive(command)
    }

    /**
     * 发送命令并等待响应
     */
    private fun sendCommandAndWaitResponse(command: ByteArray, timeoutMs: Long): ByteArray? {
        synchronized(responseLock) {
            responseData = null
            responseLatch = CountDownLatch(1)
        }

        sendCommand(command)

        return try {
            val received = responseLatch?.await(timeoutMs, TimeUnit.MILLISECONDS) ?: false
            if (received) {
                synchronized(responseLock) {
                    responseData?.also {
                        POPLogger.v("$TAG - <<< 响应: ${HexUtil.formatHexString(it, true)}")
                    }
                }
            } else {
                POPLogger.w("$TAG - 等待响应超时 (${timeoutMs}ms)")
                null
            }
        } catch (e: Exception) {
            POPLogger.e("$TAG - 等待响应异常: ${e.message}")
            null
        }
    }

    /**
     * 检查是否为有效的升级响应
     */
    private fun isValidUpgradeResponse(data: ByteArray): Boolean {
        return data.size >= 6 &&
                data[0] == STX &&
                data[1] == SIGN1 &&
                data[2] == SIGN2 &&
                data[data.size - 1] == ETX
    }

    /**
     * 检查ACK响应
     */
    private fun checkAckResponse(response: ByteArray?): Boolean {
        return response != null &&
                response.size >= 6 &&
                response[5] == ACK
    }

    /**
     * 检查CRC错误响应
     */
    private fun checkCrcError(response: ByteArray?): Boolean {
        return response != null &&
                response.size >= 6 &&
                response[5] == CRC_ERROR
    }

    /**
     * 检查USB连接
     */
    private fun checkUSBConnection(): Boolean {
        val connected = usbDevice.hasInputPort()
        if (!connected) {
            POPLogger.e("$TAG - USB设备未连接")
        }
        return connected
    }

    /**
     * 改变状态
     */
    private fun changeState(newState: USBFirmwareUpgradeCallback.UpgradeState) {
        if (currentState != newState) {
            currentState = newState
            POPLogger.d("$TAG - 状态变化: $newState")
            handler.post {
                callback?.onUpgradeStateChanged(newState)
            }
        }
    }

    /**
     * 通知错误
     */
    private fun notifyError(errorCode: Int, errorMsg: String) {
        POPLogger.e("$TAG - 错误[$errorCode]: $errorMsg")
        changeState(USBFirmwareUpgradeCallback.UpgradeState.FAILED)
        isUpgrading.set(false)
        handler.post {
            callback?.onUpgradeFailed(errorCode, errorMsg)
        }
    }
}