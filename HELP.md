# Help for the DiGiCo module

** Folowing commands are supported:

* Mute channel
* Solo channel
* Phantom Channel
* Set fader of channel
* Fire Snapshot number (0-9999)
* Fire Next Snapshot
* Fire Previous Snapshot
* Fire Macro (1-256)

** Folowing feedbacks are supported:

* Macro feedback

** Note on feedbacks, Companion needs to be added to the DiGiCo console
external control setup as a DiGiCo Pad, not as as a other OSC device, to get
bi-directional feedback. Only one device with bi-directional control can be enabled at a time.
 Feedback status are also not polled from the mixer, so only update when a macro is pressed.

Would you like some more commands? Just ask on Github.
