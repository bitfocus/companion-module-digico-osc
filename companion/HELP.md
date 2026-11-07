## DiGiCo SD / Quantum setup

Configure a **DiGiCo Pad** external-control device on the console, then configure the DiGiCo module with the matching network ports. The steps below apply to SD and Quantum consoles; the required Commands Allowed file depends on the console family.

The examples use UDP ports `7000` and `7001` for OSC communication. These differ from Companion's default Web UI port `8000`.

### 1. Enable External Control

On the console, open **System → External Control** and set **Enable External Control** to **Yes**.

### 2. Add the Companion device

Under **External Devices**:

1. Select **Add Device** and choose **DiGiCo Pad**.
2. Name the device (for example, `Companion`).
3. Enter the IP address of the computer running the DiGiCo module. This is the Companion computer's address, not the console's.
4. Set **Send** to `7000` and **Rcv** to `7001`, then enable the device.

Use **DiGiCo Pad**, rather than **Other OSC**, to access DiGiCo's remote-control command set.

### 3. Load the console's Commands Allowed file

In the **Commands Allowed** section at the bottom of External Control, select **Load** and choose the file for your console family. If an incorrect command set is already loaded, select **Clear All** first.

| Console family                | Commands Allowed file                        |
| ----------------------------- | -------------------------------------------- |
| SD8, SD9, SD11, SD12, SD12-96 | `iPadv2sd8-9-11-12`                          |
| Quantum                       | `ipad_q3` (the iPad v2 Quantum command file) |

After loading, confirm the command list is populated and **No commands are enabled** is no longer shown.

### 4. Configure the DiGiCo module

In the module, use the console's **Local IP Address** from the External Control window as the destination, and set the ports as follows:

| Module setting        | Value                        |
| --------------------- | ---------------------------- |
| Receive/listen port   | `7000`                       |
| Send destination port | `7001`                       |
| Send destination IP   | Console **Local IP Address** |

The port numbers are from the console's perspective: its **Rcv 7001** receives Companion commands, and its **Send 7000** sends console feedback to the Companion computer.

### 5. Check the connection settings

- External Control and the DiGiCo Pad device are enabled.
- The DiGiCo Pad IP address is the Companion computer's IP address.
- **Bundles**: Off.
- **Suppress OSC Retransmit**: On.
- The correct Commands Allowed file is loaded and its commands are enabled.

### 6. Add an iPad at the same time (optional)

The module can relay OSC between the console and a DiGiCo iPad app while it remains connected to Companion.

1. In the module connection settings, enable **Enable simultaneous iPad connection**.
2. Set **iPad IP Address** to the iPad's IP address on the same network as the Companion computer.
3. Set the iPad relay ports. The defaults are **iPad Receive Port** `7002` and **iPad Transmit Port** `7003`. The receive port must differ from the module's **Receive Port** (`7000` by default).
4. In the DiGiCo iPad app, set its console/OSC destination IP to the Companion computer's IP address and its send/destination port to the module's **iPad Receive Port**. Set the app's OSC receive/listen port to the module's **iPad Transmit Port**.

Port direction is from the module's perspective: OSC from the iPad arrives at Companion on `7002`, is forwarded to the console using the module's normal transmit settings, and console OSC replies are sent to the iPad at its configured IP and port `7003`. If you change either iPad port in Companion, use the matching port in the app. Keep these ports available on the network and firewall.

## Using actions

Choose the relevant DiGiCo action and select the channel, output, snapshot, macro, or other item. Where a selector supports multiple choices, use it to target more than one item; **All** targets every available choice. Numeric values use the units shown in the field label. **Relative** applies a change to the current value, and **Cross-fade** ramps supported numeric values over the selected duration.

On/off actions provide **Off**, **On**, and **Toggle** where the console command supports them. Toggle reads the current console value before sending the opposite state.

## Using feedbacks

Value feedbacks report the selected console value for expressions and Companion logic. Their results can also drive text or internal actions. For button coloring, use the matching **(On)** boolean feedback for supported on/off parameters; set its feedback style in Companion to choose the active color. **Macro button state** is a boolean feedback for macro buttons.

## Variables

The module provides count variables for channel and entity families, plus **Filename** for the current console session filename. Counts update as the module discovers the console's available channels and records. Use the variable picker to see the exact variable names available for this connection.
