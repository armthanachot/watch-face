import Toybox.Graphics;
import Toybox.ActivityMonitor;
import Toybox.Lang;
import Toybox.Math;
import Toybox.SensorHistory;
import Toybox.System;
import Toybox.Time;
import Toybox.Time.Gregorian;
import Toybox.WatchUi;

class Watch_FaceView extends WatchUi.WatchFace {

    const COLOR_BLACK = 0x000000;
    const COLOR_WHITE = 0xF3F0EA;
    const COLOR_MUTED = 0x7E8A96;
    const COLOR_DIM = 0x36414B;
    const COLOR_LINE = 0x1A2C35;
    const COLOR_GOLD = 0xF2C15E;
    const COLOR_AMBER = 0xFFB43B;
    const COLOR_BLUE = 0x72DDF7;
    const COLOR_RED = 0xFF6257;
    const COLOR_MINT = 0x66DCEB;
    const COLOR_PINK = 0xFF78B7;
    const COLOR_GREEN = 0x58D68D;
    const COLOR_PURPLE = 0xA678FF;

    const MORNING_START_HOUR = 5;
    const DAY_START_HOUR = 10;
    const EVENING_START_HOUR = 16;
    const NIGHT_START_HOUR = 19;

    var _mountainStrip;
    var _backgroundKey = -1;
    var _metricFont;
    var _metricLabelFont;
    var _microFont;
    var _smallFont;
    var _sideValueFont;
    var _dateFont;
    var _timeFont;

    function initialize() {
        WatchFace.initialize();
    }

    function onLayout(dc as Dc) as Void {
        // Venu 3: keep all typography comfortably inside the circular safe area.
        _metricFont = Graphics.getVectorFont({ :face => "RobotoRegular", :size => 20 });
        _metricLabelFont = Graphics.getVectorFont({ :face => "RobotoRegular", :size => 10 });
        _microFont = Graphics.getVectorFont({ :face => "RobotoRegular", :size => 9 });
        _smallFont = Graphics.getVectorFont({ :face => "RobotoRegular", :size => 13 });
        _sideValueFont = Graphics.getVectorFont({ :face => "RobotoRegular", :size => 15 });
        _dateFont = Graphics.getVectorFont({ :face => "RobotoRegular", :size => 19 });
        _timeFont = Graphics.getVectorFont({ :face => "RobotoRegular", :size => 39 });
    }

    function onShow() as Void {
    }

    function onUpdate(dc as Dc) as Void {
        var now = Time.now();
        var clockTime = System.getClockTime();
        var timeString = Lang.format("$1$:$2$:$3$", [
            clockTime.hour.format("%02d"),
            clockTime.min.format("%02d"),
            clockTime.sec.format("%02d")
        ]);

        var width = dc.getWidth();
        var height = dc.getHeight();
        var cx = width / 2;
        var cy = height / 2;

        var activityInfo = ActivityMonitor.getInfo();
        var stats = System.getSystemStats();
        var steps = valueOrZero(activityInfo.steps);
        var calories = valueOrZero(activityInfo.calories);
        var distanceCm = valueOrZero(activityInfo.distance);
        var battery = clampNumber(valueOrZero(stats.battery), 0, 100);
        var heartRate = getHeartRate();
        var elevation = getCurrentElevation();
        var dateShort = Gregorian.info(now, Time.FORMAT_SHORT);
        var dateMedium = Gregorian.info(now, Time.FORMAT_MEDIUM);

        updateBackground(clockTime.hour, dateShort.month);

        var dayRingColors = getDayRingColors(dateShort.year, dateShort.month, dateShort.day);
        drawBackground(dc, width, height, cx, cy, dayRingColors);
        drawHero(dc, cx, cy, clockTime.sec);
        drawDate(dc, cx, cy, dateMedium);
        drawMainTime(dc, cx, cy, timeString);
        drawDistanceBlock(dc, cx - 118, cy + 18, distanceCm);
        drawAltitudeBlock(dc, cx + 118, cy + 18, elevation);
        drawYearProgress(dc, cx, cy, dateShort);
        drawBottomDashboard(dc, cx, cy, steps, heartRate, calories, battery);
        drawFooter(dc, cx, cy);
    }

    function drawBackground(dc as Dc, width as Number, height as Number, cx as Number, cy as Number, ringColors) as Void {
        dc.setColor(COLOR_BLACK, COLOR_BLACK);
        dc.fillRectangle(0, 0, width, height);

        // Mountain art is the furthest-back layer.
        if (_mountainStrip != null) {
            var imageWidth = _mountainStrip.getWidth();
            var imageX = cx - (imageWidth / 2);
            var imageY = cy - 138;
            dc.drawBitmap(imageX, imageY, _mountainStrip);
        }

        // Two subtle rings. Keep the day color identity without overpowering content.
        dc.setPenWidth(1);
        dc.setColor(ringColors[0], Graphics.COLOR_TRANSPARENT);
        dc.drawCircle(cx, cy, (width / 2) - 18);
        dc.setColor(ringColors[1], Graphics.COLOR_TRANSPARENT);
        dc.drawCircle(cx, cy, (width / 2) - 34);
    }

    function drawHero(dc as Dc, cx as Number, cy as Number, seconds as Number) as Void {
        drawSecondsDial(dc, cx - 96, cy - 98, 26, seconds);

        var microFont = (_microFont != null) ? _microFont : Graphics.FONT_XTINY;
        dc.setColor(COLOR_MUTED, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, cy - 66, microFont, "EXPLORE MORE TODAY", Graphics.TEXT_JUSTIFY_CENTER);
    }

    function drawDate(dc as Dc, cx as Number, cy as Number, date) as Void {
        var dateFont = (_dateFont != null) ? _dateFont : Graphics.FONT_SMALL;

        dc.setColor(COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx - 47, cy - 48, dateFont, date.day_of_week, Graphics.TEXT_JUSTIFY_CENTER);

        dc.setColor(COLOR_GOLD, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, cy - 48, dateFont, date.day, Graphics.TEXT_JUSTIFY_CENTER);

        dc.setColor(COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx + 49, cy - 48, dateFont, date.month, Graphics.TEXT_JUSTIFY_CENTER);

        dc.setPenWidth(1);
        dc.setColor(COLOR_LINE, Graphics.COLOR_TRANSPARENT);
        dc.drawLine(cx - 116, cy - 23, cx + 116, cy - 23);
    }

    function drawMainTime(dc as Dc, cx as Number, cy as Number, timeString as String) as Void {
        var timeFont = (_timeFont != null) ? _timeFont : Graphics.FONT_LARGE;
        dc.setColor(COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, cy - 13, timeFont, timeString, Graphics.TEXT_JUSTIFY_CENTER);
    }

    function drawDistanceBlock(dc as Dc, x as Number, y as Number, distanceCm as Number) as Void {
        drawDistanceIcon(dc, x, y - 4);
        var sideFont = (_sideValueFont != null) ? _sideValueFont : Graphics.FONT_XTINY;
        dc.setColor(COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(x, y + 16, sideFont, formatDistance(distanceCm), Graphics.TEXT_JUSTIFY_CENTER);
    }

    function drawAltitudeBlock(dc as Dc, x as Number, y as Number, elevation) as Void {
        drawMountainIcon(dc, x, y - 5);
        var sideFont = (_sideValueFont != null) ? _sideValueFont : Graphics.FONT_XTINY;
        dc.setColor(COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(x, y + 16, sideFont, formatAltitude(elevation), Graphics.TEXT_JUSTIFY_CENTER);
    }

    function drawYearProgress(dc as Dc, cx as Number, cy as Number, dateInfo) as Void {
        var dayOfYear = getDayOfYear(dateInfo.year, dateInfo.month, dateInfo.day);
        var daysInYear = isLeapYear(dateInfo.year) ? 366 : 365;
        var progress = dayOfYear.toFloat() / daysInYear.toFloat();
        var width = 146;
        var x = cx - (width / 2);
        var y = cy + 60;

        dc.setColor(COLOR_DIM, COLOR_DIM);
        dc.fillRectangle(x, y, width, 4);

        dc.setColor(COLOR_GOLD, COLOR_GOLD);
        dc.fillRectangle(x, y, (width * progress).toNumber(), 4);

        var microFont = (_microFont != null) ? _microFont : Graphics.FONT_XTINY;
        dc.setColor(COLOR_MUTED, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, y + 8, microFont,
            "DAY " + dayOfYear.format("%d") + "/" + daysInYear.format("%d"),
            Graphics.TEXT_JUSTIFY_CENTER);
    }

    function drawBottomDashboard(dc as Dc, cx as Number, cy as Number, steps as Number, heartRate, calories as Number, battery as Number) as Void {
        var y = cy + 105;

        // Pull the four metrics inward so they never compete with the rings.
        var x1 = cx - 108;
        var x2 = cx - 36;
        var x3 = cx + 36;
        var x4 = cx + 108;

        drawDashboardMetric(dc, x1, y, 0, formatSteps(steps), "STEPS", COLOR_MINT);
        drawDashboardMetric(dc, x2, y, 1, formatNullable(heartRate), "BPM", COLOR_RED);
        drawDashboardMetric(dc, x3, y, 2, calories.toString(), "KCAL", COLOR_AMBER);
        drawDashboardMetric(dc, x4, y, 3, battery.format("%d") + "%", "BATTERY", COLOR_BLUE);

        dc.setPenWidth(1);
        dc.setColor(COLOR_LINE, Graphics.COLOR_TRANSPARENT);
        dc.drawLine(cx - 72, y - 16, cx - 72, y + 37);
        dc.drawLine(cx,      y - 16, cx,      y + 37);
        dc.drawLine(cx + 72, y - 16, cx + 72, y + 37);
    }

    function drawDashboardMetric(dc as Dc, x as Number, y as Number, icon as Number, value as String, label as String, color as Number) as Void {
        drawMetricIcon(dc, x, y - 7, icon, color);

        var metricFont = (_metricFont != null) ? _metricFont : Graphics.FONT_XTINY;
        var labelFont = (_metricLabelFont != null) ? _metricLabelFont : Graphics.FONT_XTINY;

        dc.setColor(COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(x, y + 5, metricFont, value, Graphics.TEXT_JUSTIFY_CENTER);

        dc.setColor(COLOR_MUTED, Graphics.COLOR_TRANSPARENT);
        dc.drawText(x, y + 27, labelFont, label, Graphics.TEXT_JUSTIFY_CENTER);
    }

    function drawFooter(dc as Dc, cx as Number, cy as Number) as Void {
        var smallFont = (_smallFont != null) ? _smallFont : Graphics.FONT_XTINY;
        var y = cy + 158;

        dc.setPenWidth(1);
        dc.setColor(COLOR_LINE, Graphics.COLOR_TRANSPARENT);
        dc.drawLine(cx - 72, y + 5, cx - 43, y + 5);
        dc.drawLine(cx + 43, y + 5, cx + 72, y + 5);

        dc.setColor(COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, y - 4, smallFont, "Thanachot.T", Graphics.TEXT_JUSTIFY_CENTER);
    }





    function drawSecondsDial(dc as Dc, cx as Number, cy as Number, radius as Number, seconds as Number) as Void {
        dc.setPenWidth(2);
        dc.setColor(0x313A43, Graphics.COLOR_TRANSPARENT);
        dc.drawCircle(cx, cy, radius);
        dc.drawCircle(cx, cy, radius - 10);
        dc.setPenWidth(1);
        for (var i = 0; i < 12; i += 1) {
            var angle = 90 - (i * 30);
            var outerX = cx + (Math.cos(Math.toRadians(angle)) * radius);
            var outerY = cy - (Math.sin(Math.toRadians(angle)) * radius);
            var innerX = cx + (Math.cos(Math.toRadians(angle)) * (radius - 6));
            var innerY = cy - (Math.sin(Math.toRadians(angle)) * (radius - 6));
            dc.setColor((i % 3 == 0) ? COLOR_GOLD : COLOR_DIM, Graphics.COLOR_TRANSPARENT);
            dc.drawLine(innerX, innerY, outerX, outerY);
        }
        var secAngle = 90 - (seconds * 6);
        var handX = cx + (Math.cos(Math.toRadians(secAngle)) * (radius - 12));
        var handY = cy - (Math.sin(Math.toRadians(secAngle)) * (radius - 12));
        dc.setPenWidth(3);
        dc.setColor(COLOR_GOLD, Graphics.COLOR_TRANSPARENT);
        dc.drawLine(cx, cy, handX, handY);
        dc.fillCircle(cx, cy, 4);
    }

    function drawDistanceIcon(dc as Dc, x as Number, y as Number) as Void {
        dc.setColor(COLOR_GOLD, Graphics.COLOR_TRANSPARENT);
        dc.setPenWidth(2);
        dc.drawCircle(x - 10, y + 4, 5);
        dc.fillCircle(x - 10, y + 4, 2);
        dc.drawCircle(x + 10, y - 6, 5);
        dc.fillCircle(x + 10, y - 6, 2);
        dc.drawLine(x - 5, y + 3, x - 1, y + 1);
        dc.drawLine(x + 2, y - 1, x + 6, y - 4);
        dc.fillCircle(x, y, 1);
    }

    function drawMountainIcon(dc as Dc, x as Number, y as Number) as Void {
        dc.setColor(COLOR_GOLD, Graphics.COLOR_TRANSPARENT);
        dc.setPenWidth(3);
        dc.drawLine(x - 18, y + 8, x - 4, y - 13);
        dc.drawLine(x - 4, y - 13, x + 5, y + 1);
        dc.drawLine(x + 5, y + 1, x + 13, y - 9);
        dc.drawLine(x + 13, y - 9, x + 25, y + 8);
    }

    function drawMetricIcon(dc as Dc, x as Number, y as Number, icon as Number, color as Number) as Void {
        dc.setColor(color, Graphics.COLOR_TRANSPARENT);
        dc.setPenWidth(2);
        if (icon == 0) {
            dc.fillCircle(x - 4, y - 2, 2);
            dc.fillCircle(x + 4, y - 7, 2);
            dc.fillCircle(x + 1, y + 4, 2);
            dc.drawLine(x - 4, y - 2, x + 4, y - 7);
            dc.drawLine(x + 4, y - 7, x + 1, y + 4);
        } else if (icon == 1) {
            dc.fillCircle(x - 4, y - 4, 4);
            dc.fillCircle(x + 4, y - 4, 4);
            dc.fillCircle(x, y + 2, 5);
        } else if (icon == 2) {
            dc.fillCircle(x, y + 1, 7);
            dc.setColor(COLOR_BLACK, Graphics.COLOR_TRANSPARENT);
            dc.fillCircle(x + 3, y - 4, 4);
            dc.setColor(color, Graphics.COLOR_TRANSPARENT);
            dc.drawLine(x - 2, y - 8, x + 4, y - 15);
        } else {
            dc.drawRectangle(x - 8, y - 5, 14, 9);
            dc.fillRectangle(x + 7, y - 2, 2, 3);
            dc.fillRectangle(x - 5, y - 2, 8, 3);
        }
    }

    function updateBackground(hour as Number, month as Number) as Void {
        var key = (getThaiSeason(month) * 4) + getBackgroundPeriod(hour);
        if (key == _backgroundKey) { return; }
        if (key == 0) { _mountainStrip = WatchUi.loadResource(Rez.Drawables.BgHotMorning); }
        else if (key == 1) { _mountainStrip = WatchUi.loadResource(Rez.Drawables.BgHotDay); }
        else if (key == 2) { _mountainStrip = WatchUi.loadResource(Rez.Drawables.BgHotEvening); }
        else if (key == 3) { _mountainStrip = WatchUi.loadResource(Rez.Drawables.BgHotNight); }
        else if (key == 4) { _mountainStrip = WatchUi.loadResource(Rez.Drawables.BgRainyMorning); }
        else if (key == 5) { _mountainStrip = WatchUi.loadResource(Rez.Drawables.BgRainyDay); }
        else if (key == 6) { _mountainStrip = WatchUi.loadResource(Rez.Drawables.BgRainyEvening); }
        else if (key == 7) { _mountainStrip = WatchUi.loadResource(Rez.Drawables.BgRainyNight); }
        else if (key == 8) { _mountainStrip = WatchUi.loadResource(Rez.Drawables.BgCoolMorning); }
        else if (key == 9) { _mountainStrip = WatchUi.loadResource(Rez.Drawables.BgCoolDay); }
        else if (key == 10) { _mountainStrip = WatchUi.loadResource(Rez.Drawables.BgCoolEvening); }
        else { _mountainStrip = WatchUi.loadResource(Rez.Drawables.BgCoolNight); }
        _backgroundKey = key;
    }

    function getDayRingColors(year as Number, month as Number, day as Number) {
        // Sakamoto's algorithm: 0=Sunday ... 6=Saturday.
        var offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
        var adjustedYear = year;

        if (month < 3) {
            adjustedYear -= 1;
        }

        var weekday = (
            adjustedYear
            + Math.floor(adjustedYear.toFloat() / 4.0).toNumber()
            - Math.floor(adjustedYear.toFloat() / 100.0).toNumber()
            + Math.floor(adjustedYear.toFloat() / 400.0).toNumber()
            + offsets[month - 1]
            + day
        ) % 7;

        // Muted outer + slightly brighter inner ring.
        if (weekday == 0) { return [0x3B2025, 0x633039]; } // Sunday - red
        if (weekday == 1) { return [0x3D3720, 0x665A2C]; } // Monday - yellow
        if (weekday == 2) { return [0x40243A, 0x693553]; } // Tuesday - pink
        if (weekday == 3) { return [0x1E392F, 0x2F5D4B]; } // Wednesday - green
        if (weekday == 4) { return [0x402D20, 0x68472B]; } // Thursday - orange
        if (weekday == 5) { return [0x203643, 0x31586A]; } // Friday - blue
        return [0x302440, 0x513B6B];                       // Saturday - purple
    }

    function getThaiSeason(month as Number) as Number {
        if ((month >= 3) && (month <= 5)) { return 0; }
        if ((month >= 6) && (month <= 10)) { return 1; }
        return 2;
    }

    function getBackgroundPeriod(hour as Number) as Number {
        if ((hour >= MORNING_START_HOUR) && (hour < DAY_START_HOUR)) { return 0; }
        if ((hour >= DAY_START_HOUR) && (hour < EVENING_START_HOUR)) { return 1; }
        if ((hour >= EVENING_START_HOUR) && (hour < NIGHT_START_HOUR)) { return 2; }
        return 3;
    }

    function getHeartRate() {
        var iterator = ActivityMonitor.getHeartRateHistory(1, true);
        if (iterator != null) {
            var sample = iterator.next();
            if ((sample != null) && (sample.heartRate != null)) { return sample.heartRate; }
        }
        return null;
    }

    function getCurrentElevation() {
        var iterator = SensorHistory.getElevationHistory({ :period => 1, :order => SensorHistory.ORDER_NEWEST_FIRST });
        if (iterator != null) {
            var sample = iterator.next();
            if ((sample != null) && (sample.data != null)) { return Math.round(sample.data.toFloat()).toNumber(); }
        }
        return null;
    }

    function valueOrZero(value) as Number {
        if (value == null) { return 0; }
        return value;
    }

    function clampNumber(value as Number, minValue as Number, maxValue as Number) as Number {
        if (value < minValue) { return minValue; }
        if (value > maxValue) { return maxValue; }
        return value;
    }

    function formatNullable(value) as String {
        if (value == null) { return "--"; }
        return value.toString();
    }

    function formatSteps(value as Number) as String {
        if (value >= 1000) {
            return Lang.format("$1$.$2$K", [
                (value / 1000).format("%d"),
                ((value % 1000) / 100).format("%d")
            ]);
        }
        return value.toString();
    }

    function formatDistance(distanceCm as Number) as String {
        // Keep all values used by modulo/format("%d") as integer Number.
        // Math.round() returns a Float on Connect IQ, so explicitly convert it.
        var tenths = Math.round(distanceCm.toFloat() / 10000.0).toNumber();
        var whole = Math.floor(tenths.toFloat() / 10.0).toNumber();
        var decimal = tenths - (whole * 10);
        return whole.format("%d") + "." + decimal.format("%d") + " km";
    }

    function formatAltitude(value) as String {
        if (value == null) { return "-- m"; }
        return value.format("%d") + " m";
    }

    function getDayOfYear(year as Number, month as Number, day as Number) as Number {
        var daysBeforeMonth = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
        var result = daysBeforeMonth[month - 1] + day;
        if (isLeapYear(year) && (month > 2)) { result += 1; }
        return result;
    }

    function isLeapYear(year as Number) as Boolean {
        if ((year % 400) == 0) { return true; }
        if ((year % 100) == 0) { return false; }
        return ((year % 4) == 0);
    }

    function onHide() as Void {
    }

    function onExitSleep() as Void {
    }

    function onEnterSleep() as Void {
    }
}
