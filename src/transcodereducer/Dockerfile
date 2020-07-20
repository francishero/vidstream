FROM node:14-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install

# If you are building your code for production
# RUN npm ci --only=production

# Bundle app source
COPY . .

RUN apt-get update && apt-get install -y ca-certificates wget
RUN mkdir ffmpeg && cd ffmpeg \
    && wget https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
    && tar -xvf ffmpeg-release-amd64-static.tar.xz --strip-components 1 \
    && cp ffmpeg /bin/ \
    && wget https://github.com/google/shaka-packager/releases/download/v2.4.2/packager-linux \
    && mv packager-linux packager && chmod +x packager \
    && cp packager /bin/ \
    && cd ../ \
    && rm -rf ffmpeg

CMD [ "node", "--inspect=0.0.0.0:9222", "index.js" ]