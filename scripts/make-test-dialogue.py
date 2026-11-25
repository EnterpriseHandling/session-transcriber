# Builds a made-up two-person practice conversation with computer voices, for testing only.
import subprocess, json, wave, struct, os, random
random.seed(7)
C = "voice-en-gb-southern_english_female-low/en-gb-southern_english_female-low.onnx"   # counsellor
K = "voice-en-gb-alan-low/en-gb-alan-low.onnx"                                         # client
lines = [
 ("A", "Hello, come in and take a seat. Thanks for coming along today. Before we start, I just want to remind you that this is a practice session, and we have about ten minutes together."),
 ("B", "Okay, thank you. That sounds fine."),
 ("A", "So, what would you like to talk about today?"),
 ("B", "Well, I have been feeling quite overwhelmed with the house move. There is so much to organise, and I keep putting things off until the last minute."),
 ("A", "Mm-hm."),
 ("B", "Then I end up doing everything late at night, and I am exhausted the next day at work."),
 ("A", "It sounds like the move is taking up a lot of your energy, and the more tired you get, the harder it is to make a start."),
 ("B", "Yes, exactly. That is exactly it. I look at the list and I just freeze."),
 ("A", "You freeze. What is that like for you, in the moment?"),
 ("B", "It is a bit like standing at the bottom of a very big hill. I know I have to climb it, but I cannot see where the path begins."),
 ("A", "That is a very clear picture. A big hill, and no obvious first step."),
 ("B", "Right."),
 ("A", "I wonder what the smallest possible first step might look like?"),
 ("B", "Probably just packing one box. The books in the spare room, maybe. That would take twenty minutes."),
 ("A", "One box of books. How does it feel when you say that out loud?"),
 ("B", "Honestly, a bit lighter. It sounds silly, but one box feels possible."),
 ("A", "It does not sound silly at all. You noticed that when the task is smaller, the feeling changes."),
 ("B", "Yes. I think I have been looking at the whole hill, and not at my own feet."),
 ("A", "Okay. We are coming towards the end of our time. Is there anything you would like to take away from today?"),
 ("B", "I will pack one box tonight, and I will stop looking at the whole list. Thank you, this has really helped."),
 ("A", "You are very welcome. Thank you for sharing that with me."),
]
SR = 16000
audio = []
truth = []
def pause(sec): audio.extend([0] * int(sec * SR))
pause(0.8)
for i, (who, text) in enumerate(lines):
    out = f"line{i}.wav"
    subprocess.run(["python3", "-m", "piper", "-m", C if who == "A" else K, "-f", out, "--sentence-silence", "0.25"], input=text.encode(), check=True, capture_output=True)
    with wave.open(out) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1
        pcm = list(struct.unpack(f"<{w.getnframes()}h", w.readframes(w.getnframes())))
    os.remove(out)
    start = len(audio) / SR
    audio.extend(pcm)
    truth.append({"speaker": who, "start": round(start, 2), "end": round(len(audio) / SR, 2), "text": text})
    pause(random.uniform(0.35, 0.9))
pause(0.5)
# a little steady room noise so it is not unrealistically clean
audio = [max(-32768, min(32767, int(v * 0.8 + random.gauss(0, 40)))) for v in audio]
with wave.open("dialogue.wav", "w") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(struct.pack(f"<{len(audio)}h", *audio))
json.dump(truth, open("dialogue.json", "w"), indent=1)
print(len(audio) / SR, "seconds,", len(lines), "turns")
