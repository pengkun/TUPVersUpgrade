#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOReturn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <IOKit/usb/USB.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define SOUNDWALKER_VENDOR_ID 0x5952
#define SOUNDWALKER_PRODUCT_ID 0x4e41

#define STX 0xF0
#define SIGN1 0x53
#define SIGN2 0x57
#define ETX 0xF7
#define ACK 0x06
#define CRC_ERROR 0x13
#define CMD_INIT 0x01
#define CMD_DATA_BASE 0x02
#define CMD_FINISH 0x10
#define TRANSFER_END 0x04
#define LINES_PER_CMD 128
#define MAX_RETRY 3

typedef struct {
    IOUSBInterfaceInterface **interface;
    UInt8 in_pipe;
    UInt8 out_pipe;
    UInt16 out_packet_size;
} UsbMidi;

typedef struct {
    char **items;
    size_t count;
} FirmwareLines;

static const char *ioreturn_name(IOReturn result) {
    switch (result) {
        case kIOReturnSuccess: return "success";
        case kIOReturnError: return "error";
        case kIOReturnNoMemory: return "noMemory";
        case kIOReturnNoResources: return "noResources";
        case kIOReturnNoDevice: return "noDevice";
        case kIOReturnNotPrivileged: return "notPrivileged";
        case kIOReturnBadArgument: return "badArgument";
        case kIOReturnExclusiveAccess: return "exclusiveAccess";
        case kIOReturnUnsupported: return "unsupported";
        case kIOReturnIOError: return "ioError";
        case kIOReturnNotOpen: return "notOpen";
        case kIOReturnTimeout: return "timeout";
        case kIOReturnNotPermitted: return "notPermitted";
        default: return "unknown";
    }
}

static const char *direction_name(UInt8 direction) {
    switch (direction) {
        case kUSBOut: return "out";
        case kUSBIn: return "in";
        case kUSBNone: return "none";
        case kUSBAnyDirn: return "any";
        default: return "unknown";
    }
}

static const char *transfer_name(UInt8 transfer_type) {
    switch (transfer_type) {
        case kUSBControl: return "control";
        case kUSBIsoc: return "isochronous";
        case kUSBBulk: return "bulk";
        case kUSBInterrupt: return "interrupt";
        case kUSBAnyType: return "any";
        default: return "unknown";
    }
}

static uint64_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ((uint64_t)ts.tv_sec * 1000ULL) + ((uint64_t)ts.tv_nsec / 1000000ULL);
}

static void print_json_string(const char *value) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
        switch (*p) {
            case '"': printf("\\\""); break;
            case '\\': printf("\\\\"); break;
            case '\b': printf("\\b"); break;
            case '\f': printf("\\f"); break;
            case '\n': printf("\\n"); break;
            case '\r': printf("\\r"); break;
            case '\t': printf("\\t"); break;
            default:
                if (*p < 0x20) {
                    printf("\\u%04x", *p);
                } else {
                    putchar(*p);
                }
        }
    }
    putchar('"');
}

static void print_ioreturn(const char *label, IOReturn result) {
    printf("\"%s\":\"0x%08x\",\"%sName\":\"%s\"", label, result, label, ioreturn_name(result));
}

static void emit_message(const char *type, const char *message) {
    printf("{\"type\":\"%s\",\"message\":", type);
    print_json_string(message);
    printf("}\n");
    fflush(stdout);
}

static void emit_log(const char *fmt, ...) {
    char message[1024];
    va_list args;
    va_start(args, fmt);
    vsnprintf(message, sizeof(message), fmt, args);
    va_end(args);
    emit_message("log", message);
}

static void emit_error(const char *fmt, ...) {
    char message[1024];
    va_list args;
    va_start(args, fmt);
    vsnprintf(message, sizeof(message), fmt, args);
    va_end(args);
    emit_message("error", message);
}

static void emit_progress(const char *stage, int percent, int current, int total) {
    printf("{\"type\":\"progress\",\"stage\":");
    print_json_string(stage);
    printf(",\"percent\":%d", percent);
    if (total > 0) printf(",\"current\":%d,\"total\":%d", current, total);
    printf("}\n");
    fflush(stdout);
}

static char *copy_string_property(io_service_t service, const char *key) {
    CFStringRef cf_key = CFStringCreateWithCString(kCFAllocatorDefault, key, kCFStringEncodingUTF8);
    if (!cf_key) return NULL;

    CFTypeRef value = IORegistryEntryCreateCFProperty(service, cf_key, kCFAllocatorDefault, 0);
    CFRelease(cf_key);
    if (!value) return NULL;

    char buffer[512];
    Boolean ok = false;
    if (CFGetTypeID(value) == CFStringGetTypeID()) {
        ok = CFStringGetCString((CFStringRef)value, buffer, sizeof(buffer), kCFStringEncodingUTF8);
    }
    CFRelease(value);
    if (!ok) return NULL;

    char *copy = malloc(strlen(buffer) + 1);
    if (!copy) return NULL;
    strcpy(copy, buffer);
    return copy;
}

static int copy_int_property(io_service_t service, const char *key, int *out_value) {
    CFStringRef cf_key = CFStringCreateWithCString(kCFAllocatorDefault, key, kCFStringEncodingUTF8);
    if (!cf_key) return 0;

    CFTypeRef value = IORegistryEntryCreateCFProperty(service, cf_key, kCFAllocatorDefault, 0);
    CFRelease(cf_key);
    if (!value) return 0;

    int ok = 0;
    if (CFGetTypeID(value) == CFNumberGetTypeID()) {
        ok = CFNumberGetValue((CFNumberRef)value, kCFNumberIntType, out_value);
    }
    CFRelease(value);
    return ok;
}

static int target_interface(io_service_t service) {
    int vendor_id = 0;
    int product_id = 0;
    return copy_int_property(service, "idVendor", &vendor_id) &&
           copy_int_property(service, "idProduct", &product_id) &&
           vendor_id == SOUNDWALKER_VENDOR_ID &&
           product_id == SOUNDWALKER_PRODUCT_ID;
}

static IOUSBInterfaceInterface **create_interface_interface(io_service_t service, IOReturn *out_result) {
    IOCFPlugInInterface **plugin = NULL;
    SInt32 score = 0;
    IOReturn result = IOCreatePlugInInterfaceForService(
        service,
        kIOUSBInterfaceUserClientTypeID,
        kIOCFPlugInInterfaceID,
        &plugin,
        &score
    );
    if (result != kIOReturnSuccess || !plugin) {
        if (out_result) *out_result = result;
        return NULL;
    }

    IOUSBInterfaceInterface **interface = NULL;
    HRESULT query_result = (*plugin)->QueryInterface(
        plugin,
        CFUUIDGetUUIDBytes(kIOUSBInterfaceInterfaceID942),
        (LPVOID *)&interface
    );
    (*plugin)->Release(plugin);

    if (query_result || !interface) {
        if (out_result) *out_result = (IOReturn)query_result;
        return NULL;
    }
    if (out_result) *out_result = kIOReturnSuccess;
    return interface;
}

static void print_optional_string_property(io_service_t service, const char *json_key, const char *registry_key) {
    char *value = copy_string_property(service, registry_key);
    if (!value) return;
    printf(",\"%s\":", json_key);
    print_json_string(value);
    free(value);
}

static void probe_interface(io_service_t service) {
    printf("{\"idVendor\":\"0x%04x\",\"idProduct\":\"0x%04x\"",
           SOUNDWALKER_VENDOR_ID, SOUNDWALKER_PRODUCT_ID);
    print_optional_string_property(service, "product", "USB Product Name");
    print_optional_string_property(service, "vendor", "USB Vendor Name");
    print_optional_string_property(service, "exclusiveOwner", "UsbExclusiveOwner");

    IOReturn intf_result = kIOReturnSuccess;
    IOUSBInterfaceInterface **interface = create_interface_interface(service, &intf_result);
    printf(",");
    print_ioreturn("createPlugin", intf_result);

    if (!interface) {
        printf("}");
        return;
    }

    UInt8 interface_number = 0;
    UInt8 class_id = 0;
    UInt8 subclass_id = 0;
    UInt8 protocol_id = 0;
    UInt8 endpoint_count = 0;
    (*interface)->GetInterfaceNumber(interface, &interface_number);
    (*interface)->GetInterfaceClass(interface, &class_id);
    (*interface)->GetInterfaceSubClass(interface, &subclass_id);
    (*interface)->GetInterfaceProtocol(interface, &protocol_id);
    (*interface)->GetNumEndpoints(interface, &endpoint_count);

    int is_midi_streaming = class_id == 1 && subclass_id == 3 && endpoint_count >= 2;
    printf(",\"number\":%u,\"class\":%u,\"subclass\":%u,\"protocol\":%u,\"endpointCount\":%u,\"midiStreamingCandidate\":%s",
           interface_number, class_id, subclass_id, protocol_id, endpoint_count, is_midi_streaming ? "true" : "false");

    IOReturn open_result = (*interface)->USBInterfaceOpen(interface);
    printf(",");
    print_ioreturn("open", open_result);
    printf(",\"seizeAttempted\":false");

    if (open_result == kIOReturnSuccess) {
        printf(",\"endpoints\":[");
        for (UInt8 pipe = 1; pipe <= endpoint_count; pipe++) {
            UInt8 direction = 0;
            UInt8 number = 0;
            UInt8 transfer_type = 0;
            UInt8 interval = 0;
            UInt16 max_packet_size = 0;
            IOReturn pipe_result = (*interface)->GetPipeProperties(
                interface,
                pipe,
                &direction,
                &number,
                &transfer_type,
                &max_packet_size,
                &interval
            );
            if (pipe > 1) printf(",");
            printf("{\"pipe\":%u,", pipe);
            print_ioreturn("result", pipe_result);
            printf(",\"direction\":\"%s\",\"number\":%u,\"transferType\":\"%s\",\"maxPacketSize\":%u,\"interval\":%u}",
                   direction_name(direction), number, transfer_name(transfer_type), max_packet_size, interval);
        }
        printf("]");
        (*interface)->USBInterfaceClose(interface);
    }

    (*interface)->Release(interface);
    printf("}");
}

static int probe_command(void) {
    CFMutableDictionaryRef matching = IOServiceMatching("IOUSBHostInterface");
    if (!matching) {
        printf("{\"type\":\"usb-probe\",\"error\":\"IOServiceMatching failed\"}\n");
        return 1;
    }

    io_iterator_t iterator = IO_OBJECT_NULL;
    IOReturn result = IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator);
    if (result != kIOReturnSuccess) {
        printf("{\"type\":\"usb-probe\",");
        print_ioreturn("matching", result);
        printf("}\n");
        return 1;
    }

    printf("{\"type\":\"usb-probe\",\"mode\":\"interface-open-nonseize\",\"vendorId\":\"0x%04x\",\"productId\":\"0x%04x\",\"interfaces\":[",
           SOUNDWALKER_VENDOR_ID, SOUNDWALKER_PRODUCT_ID);
    int first_interface = 1;
    io_service_t service;
    while ((service = IOIteratorNext(iterator))) {
        if (!target_interface(service)) {
            IOObjectRelease(service);
            continue;
        }
        if (!first_interface) printf(",");
        first_interface = 0;
        probe_interface(service);
        IOObjectRelease(service);
    }
    IOObjectRelease(iterator);
    printf("]}\n");
    return 0;
}

static void close_usb_midi(UsbMidi *midi) {
    if (midi->interface) {
        (*midi->interface)->USBInterfaceClose(midi->interface);
        (*midi->interface)->Release(midi->interface);
        midi->interface = NULL;
    }
}

static int open_usb_midi(UsbMidi *midi) {
    memset(midi, 0, sizeof(*midi));

    CFMutableDictionaryRef matching = IOServiceMatching("IOUSBHostInterface");
    if (!matching) {
        emit_error("IOServiceMatching(IOUSBHostInterface) failed");
        return 0;
    }

    io_iterator_t iterator = IO_OBJECT_NULL;
    IOReturn match_result = IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator);
    if (match_result != kIOReturnSuccess) {
        emit_error("USB接口枚举失败: %s(0x%08x)", ioreturn_name(match_result), match_result);
        return 0;
    }

    io_service_t service;
    while ((service = IOIteratorNext(iterator))) {
        if (!target_interface(service)) {
            IOObjectRelease(service);
            continue;
        }

        IOReturn intf_result = kIOReturnSuccess;
        IOUSBInterfaceInterface **interface = create_interface_interface(service, &intf_result);
        IOObjectRelease(service);
        if (!interface) {
            emit_log("跳过USB接口: createPlugin=%s(0x%08x)", ioreturn_name(intf_result), intf_result);
            continue;
        }

        UInt8 class_id = 0;
        UInt8 subclass_id = 0;
        UInt8 endpoint_count = 0;
        (*interface)->GetInterfaceClass(interface, &class_id);
        (*interface)->GetInterfaceSubClass(interface, &subclass_id);
        (*interface)->GetNumEndpoints(interface, &endpoint_count);
        if (!(class_id == 1 && subclass_id == 3 && endpoint_count >= 2)) {
            (*interface)->Release(interface);
            continue;
        }

        IOReturn open_result = (*interface)->USBInterfaceOpen(interface);
        if (open_result != kIOReturnSuccess) {
            emit_log("USB MIDI streaming接口打开失败: %s(0x%08x)", ioreturn_name(open_result), open_result);
            (*interface)->Release(interface);
            continue;
        }

        UInt8 in_pipe = 0;
        UInt8 out_pipe = 0;
        UInt16 out_packet_size = 64;
        for (UInt8 pipe = 1; pipe <= endpoint_count; pipe++) {
            UInt8 direction = 0;
            UInt8 number = 0;
            UInt8 transfer_type = 0;
            UInt8 interval = 0;
            UInt16 max_packet_size = 0;
            IOReturn pipe_result = (*interface)->GetPipeProperties(
                interface,
                pipe,
                &direction,
                &number,
                &transfer_type,
                &max_packet_size,
                &interval
            );
            if (pipe_result != kIOReturnSuccess || transfer_type != kUSBBulk) continue;
            if (direction == kUSBIn) {
                in_pipe = pipe;
            } else if (direction == kUSBOut) {
                out_pipe = pipe;
                out_packet_size = max_packet_size > 0 ? max_packet_size : 64;
            }
        }

        if (!in_pipe || !out_pipe) {
            (*interface)->USBInterfaceClose(interface);
            (*interface)->Release(interface);
            emit_log("USB MIDI streaming接口缺少bulk in/out端点");
            continue;
        }

        midi->interface = interface;
        midi->in_pipe = in_pipe;
        midi->out_pipe = out_pipe;
        midi->out_packet_size = out_packet_size;
        IOObjectRelease(iterator);
        return 1;
    }

    IOObjectRelease(iterator);
    emit_error("未找到可打开的Native USB MIDI streaming接口，请确认设备未被其它程序占用");
    return 0;
}

static size_t encode_usb_midi_sysex(const uint8_t *sysex, size_t sysex_len, uint8_t **out_data) {
    size_t capacity = ((sysex_len + 2) / 3) * 4;
    uint8_t *usb = malloc(capacity);
    if (!usb) return 0;

    size_t in = 0;
    size_t out = 0;
    while (in < sysex_len) {
        size_t remaining = sysex_len - in;
        if (remaining > 3) {
            usb[out++] = 0x04;
            usb[out++] = sysex[in++];
            usb[out++] = sysex[in++];
            usb[out++] = sysex[in++];
        } else if (remaining == 1) {
            usb[out++] = 0x05;
            usb[out++] = sysex[in++];
            usb[out++] = 0x00;
            usb[out++] = 0x00;
        } else if (remaining == 2) {
            usb[out++] = 0x06;
            usb[out++] = sysex[in++];
            usb[out++] = sysex[in++];
            usb[out++] = 0x00;
        } else {
            usb[out++] = 0x07;
            usb[out++] = sysex[in++];
            usb[out++] = sysex[in++];
            usb[out++] = sysex[in++];
        }
    }

    *out_data = usb;
    return out;
}

static int usb_midi_event_data_len(uint8_t cin) {
    switch (cin) {
        case 0x2: return 2;
        case 0x3: return 3;
        case 0x4: return 3;
        case 0x5: return 1;
        case 0x6: return 2;
        case 0x7: return 3;
        case 0x8: return 3;
        case 0x9: return 3;
        case 0xA: return 3;
        case 0xB: return 3;
        case 0xC: return 2;
        case 0xD: return 2;
        case 0xE: return 3;
        case 0xF: return 1;
        default: return 0;
    }
}

static int is_valid_upgrade_response(const uint8_t *data, size_t len) {
    return len >= 6 && data[0] == STX && data[1] == SIGN1 && data[2] == SIGN2 && data[len - 1] == ETX;
}

static int send_usb_sysex(UsbMidi *midi, const uint8_t *sysex, size_t sysex_len) {
    uint8_t *usb_data = NULL;
    size_t usb_len = encode_usb_midi_sysex(sysex, sysex_len, &usb_data);
    if (!usb_len || !usb_data) {
        emit_error("USB-MIDI分包内存分配失败");
        return 0;
    }

    size_t offset = 0;
    UInt32 chunk_size = midi->out_packet_size > 0 ? midi->out_packet_size : 64;
    while (offset < usb_len) {
        UInt32 remaining = (UInt32)(usb_len - offset);
        UInt32 chunk = remaining > chunk_size ? chunk_size : remaining;
        IOReturn result = (*midi->interface)->WritePipeTO(
            midi->interface,
            midi->out_pipe,
            usb_data + offset,
            chunk,
            1000,
            5000
        );
        if (result != kIOReturnSuccess) {
            free(usb_data);
            emit_error("USB bulk写入失败: %s(0x%08x)", ioreturn_name(result), result);
            return 0;
        }
        offset += chunk;
    }

    free(usb_data);
    return 1;
}

static int wait_usb_response(UsbMidi *midi, int timeout_ms, uint8_t *response, size_t *response_len) {
    uint64_t deadline = now_ms() + (uint64_t)timeout_ms;
    uint8_t sysex[4096];
    size_t sysex_len = 0;

    while (now_ms() < deadline) {
        uint8_t buffer[512];
        UInt32 size = sizeof(buffer);
        uint64_t remaining = deadline - now_ms();
        UInt32 completion_timeout = remaining > 500 ? 500 : (UInt32)remaining;
        if (completion_timeout == 0) completion_timeout = 1;

        IOReturn result = (*midi->interface)->ReadPipeTO(
            midi->interface,
            midi->in_pipe,
            buffer,
            &size,
            100,
            completion_timeout
        );

        if (result != kIOReturnSuccess) {
            if (result == kIOReturnTimeout) continue;
            if (result == kIOReturnNoDevice || result == kIOReturnNotOpen) {
                emit_error("USB bulk读取失败: %s(0x%08x)", ioreturn_name(result), result);
                return -1;
            }
            continue;
        }
        if (size < 4) continue;

        for (UInt32 i = 0; i + 3 < size; i += 4) {
            uint8_t cin = buffer[i] & 0x0F;
            int count = usb_midi_event_data_len(cin);
            for (int j = 0; j < count; j++) {
                uint8_t byte = buffer[i + 1 + j];
                if (byte == STX) {
                    sysex_len = 0;
                    sysex[sysex_len++] = byte;
                    continue;
                }
                if (sysex_len == 0) continue;
                if (sysex_len < sizeof(sysex)) {
                    sysex[sysex_len++] = byte;
                } else {
                    sysex_len = 0;
                    continue;
                }
                if (byte == ETX) {
                    if (is_valid_upgrade_response(sysex, sysex_len)) {
                        memcpy(response, sysex, sysex_len);
                        *response_len = sysex_len;
                        return 1;
                    }
                    sysex_len = 0;
                }
            }
        }
    }

    return 0;
}

static int send_and_wait_response(UsbMidi *midi, const uint8_t *command, size_t command_len, int timeout_ms, uint8_t *response, size_t *response_len) {
    *response_len = 0;
    if (!send_usb_sysex(midi, command, command_len)) return -1;
    return wait_usb_response(midi, timeout_ms, response, response_len);
}

static int response_is_ack(const uint8_t *response, size_t response_len) {
    return response_len >= 6 && response[5] == ACK;
}

static int response_is_crc_error(const uint8_t *response, size_t response_len) {
    return response_len >= 6 && response[5] == CRC_ERROR;
}

static void response_hex(const uint8_t *response, size_t response_len, char *out, size_t out_len) {
    size_t pos = 0;
    for (size_t i = 0; i < response_len && pos + 4 < out_len; i++) {
        pos += (size_t)snprintf(out + pos, out_len - pos, "%02X%s", response[i], i + 1 == response_len ? "" : " ");
    }
    if (pos >= out_len) out[out_len - 1] = '\0';
}

static int data_ack_timeout_ms(size_t command_len) {
    int extra = (int)(((command_len + 255) / 256) * 3000);
    int timeout = 5000 + extra;
    if (timeout < 5000) timeout = 5000;
    if (timeout > 30000) timeout = 30000;
    return timeout;
}

static uint8_t *build_control_command(uint8_t cmd, const uint8_t *params, size_t params_len, size_t *out_len) {
    size_t len = 5 + params_len + 1;
    uint8_t *command = malloc(len);
    if (!command) return NULL;
    command[0] = STX;
    command[1] = SIGN1;
    command[2] = SIGN2;
    command[3] = cmd;
    command[4] = (uint8_t)(params_len & 0xFF);
    if (params_len > 0) memcpy(command + 5, params, params_len);
    command[len - 1] = ETX;
    *out_len = len;
    return command;
}

static uint8_t *build_data_command(uint8_t cmd, uint8_t pkt, const char *line, size_t line_len, size_t *out_len) {
    size_t len = 5 + line_len + 1;
    uint8_t *command = malloc(len);
    if (!command) return NULL;
    command[0] = STX;
    command[1] = SIGN1;
    command[2] = SIGN2;
    command[3] = cmd;
    command[4] = pkt;
    memcpy(command + 5, line, line_len);
    command[len - 1] = ETX;
    *out_len = len;
    return command;
}

static char *java_trim_copy(char *line) {
    unsigned char *start = (unsigned char *)line;
    while (*start && *start <= 0x20) start++;

    unsigned char *end = start + strlen((char *)start);
    while (end > start && *(end - 1) <= 0x20) end--;

    size_t len = (size_t)(end - start);
    char *copy = malloc(len + 1);
    if (!copy) return NULL;
    memcpy(copy, start, len);
    copy[len] = '\0';
    return copy;
}

static int read_firmware_lines(const char *path, FirmwareLines *lines) {
    memset(lines, 0, sizeof(*lines));
    FILE *file = fopen(path, "rb");
    if (!file) {
        emit_error("固件文件打开失败");
        return 0;
    }

    char *line = NULL;
    size_t capacity = 0;
    ssize_t read = 0;
    while ((read = getline(&line, &capacity, file)) != -1) {
        (void)read;
        char *trimmed = java_trim_copy(line);
        if (!trimmed) {
            free(line);
            fclose(file);
            emit_error("固件行内存分配失败");
            return 0;
        }
        if (trimmed[0] == '\0') {
            free(trimmed);
            continue;
        }

        char **next = realloc(lines->items, sizeof(char *) * (lines->count + 1));
        if (!next) {
            free(trimmed);
            free(line);
            fclose(file);
            emit_error("固件行数组内存分配失败");
            return 0;
        }
        lines->items = next;
        lines->items[lines->count++] = trimmed;
    }

    free(line);
    fclose(file);
    return lines->count > 0;
}

static void free_firmware_lines(FirmwareLines *lines) {
    for (size_t i = 0; i < lines->count; i++) free(lines->items[i]);
    free(lines->items);
    lines->items = NULL;
    lines->count = 0;
}

static int expect_ack(UsbMidi *midi, const uint8_t *command, size_t command_len, int timeout_ms, uint8_t *response, size_t *response_len) {
    int result = send_and_wait_response(midi, command, command_len, timeout_ms, response, response_len);
    if (result <= 0) return result;
    return response_is_ack(response, *response_len) ? 1 : 0;
}

static int upgrade_command(const char *firmware_path) {
    UsbMidi midi;
    if (!open_usb_midi(&midi)) return 1;

    printf("{\"type\":\"connected\",\"transport\":\"NativeUSB\",\"inPipe\":%u,\"outPipe\":%u,\"outPacketSize\":%u}\n",
           midi.in_pipe, midi.out_pipe, midi.out_packet_size);
    fflush(stdout);

    FirmwareLines lines;
    if (!read_firmware_lines(firmware_path, &lines)) {
        close_usb_midi(&midi);
        emit_error("升级文件为空或格式错误");
        return 1;
    }
    emit_log("固件读取完成，共 %zu 行", lines.count);

    uint8_t response[4096];
    size_t response_len = 0;
    size_t command_len = 0;
    uint8_t *command = build_control_command(CMD_INIT, NULL, 0, &command_len);
    if (!command) {
        free_firmware_lines(&lines);
        close_usb_midi(&midi);
        emit_error("初始化命令内存分配失败");
        return 1;
    }

    emit_progress("初始化", 0, 0, 0);
    int ack_result = expect_ack(&midi, command, command_len, 5000, response, &response_len);
    free(command);
    if (ack_result != 1) {
        free_firmware_lines(&lines);
        close_usb_midi(&midi);
        emit_error("初始化失败：未收到ACK");
        return 1;
    }
    usleep(200000);

    emit_progress("传输中", 1, 0, (int)lines.count);
    for (size_t index = 0; index < lines.count; index++) {
        uint8_t cmd = (uint8_t)(CMD_DATA_BASE + (index / LINES_PER_CMD));
        uint8_t pkt = (uint8_t)(index % LINES_PER_CMD);
        const char *line = lines.items[index];
        size_t line_len = strlen(line);
        command = build_data_command(cmd, pkt, line, line_len, &command_len);
        if (!command) {
            free_firmware_lines(&lines);
            close_usb_midi(&midi);
            emit_error("数据命令内存分配失败");
            return 1;
        }

        int timeout_ms = data_ack_timeout_ms(command_len);
        if (index < 5) {
            emit_log("发送行%zu: dataLen=%zu, sysexLen=%zu, timeout=%dms, transport=NativeUSB", index + 1, line_len, command_len, timeout_ms);
        }

        int ok = 0;
        for (int retry = 1; retry <= MAX_RETRY; retry++) {
            response_len = 0;
            int result = send_and_wait_response(&midi, command, command_len, timeout_ms, response, &response_len);
            if (result == 1 && response_is_ack(response, response_len)) {
                ok = 1;
                break;
            }
            if (result < 0) {
                free(command);
                free_firmware_lines(&lines);
                close_usb_midi(&midi);
                return 1;
            }
            if (result == 0) {
                emit_log("第%zu行 等待ACK超时(%dms)，重试 %d/%d", index + 1, timeout_ms, retry, MAX_RETRY);
            } else if (response_is_crc_error(response, response_len)) {
                emit_log("第%zu行 CRC错误，重试 %d/%d", index + 1, retry, MAX_RETRY);
            } else {
                char hex[512] = {0};
                response_hex(response, response_len, hex, sizeof(hex));
                emit_log("第%zu行 异常响应 %s，重试 %d/%d", index + 1, hex, retry, MAX_RETRY);
            }
            usleep(100000);
        }
        free(command);

        if (!ok) {
            free_firmware_lines(&lines);
            close_usb_midi(&midi);
            emit_error("数据传输失败，行号 %zu", index + 1);
            return 1;
        }

        if ((index + 1) % 10 == 0 || index + 1 == lines.count) {
            int percent = (int)(((index + 1) * 100) / lines.count);
            emit_log("已发送 %zu/%zu 行，进度 %d%%", index + 1, lines.count, percent);
            emit_progress("传输中", percent, (int)(index + 1), (int)lines.count);
        }
    }

    uint8_t finish_param = TRANSFER_END;
    command = build_control_command(CMD_FINISH, &finish_param, 1, &command_len);
    if (!command) {
        free_firmware_lines(&lines);
        close_usb_midi(&midi);
        emit_error("结束命令内存分配失败");
        return 1;
    }
    emit_progress("结束中", 99, (int)lines.count, (int)lines.count);
    ack_result = expect_ack(&midi, command, command_len, 10000, response, &response_len);
    free(command);
    free_firmware_lines(&lines);
    close_usb_midi(&midi);

    if (ack_result != 1) {
        emit_error("结束升级失败：未收到ACK");
        return 1;
    }

    emit_progress("升级成功", 100, 0, 0);
    emit_message("success", "升级完成");
    return 0;
}

int main(int argc, char **argv) {
    if (argc <= 1 || strcmp(argv[1], "probe") == 0) {
        return probe_command();
    }
    if (argc == 3 && strcmp(argv[1], "upgrade") == 0) {
        return upgrade_command(argv[2]);
    }
    emit_error("usage: native_usb_probe [probe|upgrade firmware.upg]");
    return 64;
}
